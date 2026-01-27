import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

let server: http.Server | null = null;
let statusBarItem: vscode.StatusBarItem;
let litellmProcess: ChildProcess | null = null;
let cliproxyapiProcess: ChildProcess | null = null;

// 配置源类型
type SettingsScope = 'global' | 'workspace';

// 配置文件信息
interface SettingsInfo {
  scope: SettingsScope;
  filePath: string;
  exists: boolean;
  hasProxyConfig: boolean;
}

// Claude settings 配置文件路径
const CLAUDE_GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// 获取当前工作区下的 settings.json 路径
function getWorkspaceSettingsPath(): string {
  // 优先使用 VSCode 的工作区路径
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.claude', 'settings.json');
  }
  // 回退到当前目录
  return path.join(process.cwd(), '.claude', 'settings.json');
}

/**
 * 获取指定作用域的配置文件路径
 */
function getSettingsFilePath(scope: SettingsScope): string {
  if (scope === 'global') {
    return CLAUDE_GLOBAL_SETTINGS_PATH;
  }
  return getWorkspaceSettingsPath();
}

/**
 * 获取配置文件信息
 */
function getSettingsInfo(scope: SettingsScope): SettingsInfo {
  const filePath = getSettingsFilePath(scope);
  const exists = fs.existsSync(filePath);
  let hasProxyConfig = false;

  if (exists) {
    const settings = readSettingsFile(filePath);
    hasProxyConfig = !!(settings?.env?.ANTHROPIC_BASE_URL);
  }

  return { scope, filePath, exists, hasProxyConfig };
}

/**
 * 检测当前激活的配置源
 * 优先级：项目配置 > 全局配置
 */
function detectActiveSettingsScope(): SettingsScope {
  const workspaceInfo = getSettingsInfo('workspace');
  if (workspaceInfo.exists) {
    return 'workspace';
  }
  return 'global';
}

// 读取和解析 settings.json
function readSettingsFile(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.warn(`读取 settings.json 失败: ${filePath}`, e);
    return null;
  }
}

// 写入 settings.json
function writeSettingsFile(filePath: string, data: any): boolean {
  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`已写入 settings.json: ${filePath}`);
    return true;
  } catch (e) {
    console.warn(`写入 settings.json 失败: ${filePath}`, e);
    return false;
  }
}

/**
 * 更新代理配置（不使用备份文件）
 * @param scope 配置作用域
 * @param enableProxy 是否启用代理（false = 透传）
 */
function updateProxyConfig(scope: SettingsScope, enableProxy: boolean): boolean {
  const filePath = getSettingsFilePath(scope);
  let settings = readSettingsFile(filePath) || {};

  // 确保 env 对象存在
  if (!settings.env) {
    settings.env = {};
  }

  const config = vscode.workspace.getConfiguration('claudeProxy');
  const port = config.get<number>('port', 4001);

  if (enableProxy) {
    // 启用代理：设置 ANTHROPIC_BASE_URL
    settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    console.log(`已启用代理模式，设置 ANTHROPIC_BASE_URL: ${filePath}`);
  } else {
    // 禁用代理：删除 ANTHROPIC_BASE_URL
    delete settings.env.ANTHROPIC_BASE_URL;

    // 如果 env 为空，删除整个 env
    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
    console.log(`已启用透传模式，移除 ANTHROPIC_BASE_URL: ${filePath}`);
  }

  return writeSettingsFile(filePath, settings);
}

/**
 * 设置透传模式（删除全局和工作区配置中的代理设置）
 */
function setPassThroughMode(): void {
  // 清理全局配置
  const globalInfo = getSettingsInfo('global');
  if (globalInfo.exists) {
    updateProxyConfig('global', false);
  }

  // 清理工作区配置
  const workspaceInfo = getSettingsInfo('workspace');
  if (workspaceInfo.exists) {
    updateProxyConfig('workspace', false);
  }
}

/**
 * 设置代理模式（在当前激活配置中设置代理）
 */
function setProxyMode(): void {
  const activeScope = detectActiveSettingsScope();
  updateProxyConfig(activeScope, true);
}

// 获取日志目录路径
function getLogDir(): string {
  return path.join(os.homedir(), '.claude', 'proxy', 'log');
}

// 确保日志目录存在
async function ensureLogDir(): Promise<void> {
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// 清理旧的日志文件
function cleanupOldLogs(): void {
  const config = vscode.workspace.getConfiguration('claudeProxy');

  // 清理 JSON 日志目录
  const logDir = getLogDir();
  if (fs.existsSync(logDir)) {
    try {
      const files = fs.readdirSync(logDir);
      for (const file of files) {
        const filePath = path.join(logDir, file);
        try {
          fs.unlinkSync(filePath);
          console.log(`已删除日志文件: ${file}`);
        } catch (e) {
          console.warn(`删除日志文件失败: ${file}`, e);
        }
      }
    } catch (e) {
      console.warn('清理JSON日志文件失败:', e);
    }
  }

  // 清理 LiteLLM 日志文件
  const litellmConfigPath = expandPath(config.get<string>('providers.litellm.configPath', '~/.claude/proxy/litellm.yaml'));
  const litellmLogPath = litellmConfigPath.replace(/\.yaml$/, '.log');
  if (fs.existsSync(litellmLogPath)) {
    try {
      fs.unlinkSync(litellmLogPath);
      console.log(`已删除 LiteLLM 日志文件: ${litellmLogPath}`);
    } catch (e) {
      console.warn(`删除 LiteLLM 日志文件失败: ${litellmLogPath}`, e);
    }
  }

  // 清理 CLIProxyAPI 日志文件
  const cliproxyapiConfigPath = expandPath(config.get<string>('providers.cliproxyapi.configPath', '~/.claude/proxy/cliproxyapi.yaml'));
  const cliproxyapiLogPath = cliproxyapiConfigPath.replace(/\.yaml$/, '.log');
  if (fs.existsSync(cliproxyapiLogPath)) {
    try {
      fs.unlinkSync(cliproxyapiLogPath);
      console.log(`已删除 CLIProxyAPI 日志文件: ${cliproxyapiLogPath}`);
    } catch (e) {
      console.warn(`删除 CLIProxyAPI 日志文件失败: ${cliproxyapiLogPath}`, e);
    }
  }
}

// 从模型名称提取模型类型 (haiku/main)
function extractModelType(modelName: string): 'haiku' | 'main' {
  const lower = modelName.toLowerCase();
  if (lower.includes('haiku')) {
    return 'haiku';
  }
  // sonnet和opus都归类为main
  return 'main';
}

// 获取目标配置
async function getTargetConfig(modelType: 'haiku' | 'main'): Promise<{
  endpoint: string;
  model?: string;
  apiKey?: string;
  authMethod?: 'token' | 'x-api-key';
} | null> {
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const mapping = config.get<string>(`mappings.${modelType}`, 'pass');

  if (mapping === 'pass') {
    // 透传模式
    return null;
  }

  // 解析映射 (格式: provider:model)
  const [provider, targetModel] = mapping.split(':');

  if (provider === 'anthropic') {
    const enabled = config.get<boolean>('providers.anthropic.enabled', false);
    if (!enabled) {
      console.warn('Anthropic provider not enabled');
      return null;
    }

    const apiKey = config.get<string>('providers.anthropic.apiKey', '');

    return {
      endpoint: 'https://api.anthropic.com',
      model: targetModel,
      apiKey,
      authMethod: 'x-api-key'
    };
  }

  if (provider === 'glm') {
    const enabled = config.get<boolean>('providers.glm.enabled', false);
    if (!enabled) {
      console.warn('GLM provider not enabled');
      return null;
    }

    const apiKey = config.get<string>('providers.glm.apiKey', '');

    return {
      endpoint: 'https://open.bigmodel.cn/api/anthropic',
      model: targetModel,
      apiKey,
      authMethod: 'x-api-key'
    };
  }

  if (provider === 'kimi') {
    const enabled = config.get<boolean>('providers.kimi.enabled', false);
    if (!enabled) {
      console.warn('Kimi provider not enabled');
      return null;
    }

    const apiKey = config.get<string>('providers.kimi.apiKey', '');

    return {
      endpoint: 'https://api.moonshot.cn/anthropic',
      model: targetModel,
      apiKey,
      authMethod: 'x-api-key'
    };
  }

  if (provider === 'minimax') {
    const enabled = config.get<boolean>('providers.minimax.enabled', false);
    if (!enabled) {
      console.warn('MiniMax provider not enabled');
      return null;
    }

    const apiKey = config.get<string>('providers.minimax.apiKey', '');

    return {
      endpoint: 'https://api.minimaxi.com/anthropic',
      model: targetModel,
      apiKey,
      authMethod: 'x-api-key'
    };
  }

  if (provider === 'deepseek') {
    const enabled = config.get<boolean>('providers.deepseek.enabled', false);
    if (!enabled) {
      console.warn('DeepSeek provider not enabled');
      return null;
    }

    const apiKey = config.get<string>('providers.deepseek.apiKey', '');

    return {
      endpoint: 'https://api.deepseek.com/anthropic',
      model: targetModel,
      apiKey,
      authMethod: 'x-api-key'
    };
  }

  if (provider === 'custom') {
    const enabled = config.get<boolean>('providers.custom.enabled', false);
    if (!enabled) {
      console.warn('Custom provider not enabled');
      return null;
    }

    const apiKey = config.get<string>('providers.custom.apiKey', '');
    const baseUrl = config.get<string>('providers.custom.baseUrl', 'https://api.siliconflow.cn');

    return {
      endpoint: baseUrl,
      model: targetModel,
      apiKey,
      authMethod: 'x-api-key'
    };
  }

  if (provider === 'litellm') {
    const enabled = config.get<boolean>('providers.litellm.enabled', false);
    if (!enabled) {
      console.warn('LiteLLM provider not enabled');
      return null;
    }

    const port = config.get<number>('providers.litellm.port', 4100);
    const apiKey = config.get<string>('providers.litellm.apiKey', '');

    return {
      endpoint: `http://127.0.0.1:${port}`,
      model: targetModel,
      apiKey: apiKey || undefined,
      authMethod: apiKey ? 'token' : undefined
    };
  }

  if (provider === 'cliproxyapi') {
    const enabled = config.get<boolean>('providers.cliproxyapi.enabled', false);
    if (!enabled) {
      console.warn('CLIProxyAPI provider not enabled');
      return null;
    }

    const port = config.get<number>('providers.cliproxyapi.port', 4200);
    const apiKey = config.get<string>('providers.cliproxyapi.apiKey', '');

    return {
      endpoint: `http://127.0.0.1:${port}`,
      model: targetModel,
      apiKey: apiKey || undefined,
      authMethod: apiKey ? 'token' : undefined
    };
  }

  // 后续可以添加其他provider的处理
  console.warn(`Unknown provider: ${provider}`);
  return null;
}

// 保存日志
async function saveLog(requestData: any, responseData: any, error?: any): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const enableJsonLogging = config.get<boolean>('enableJsonLogging', false);

  if (!enableJsonLogging) {
    return;
  }

  await ensureLogDir();

  const timestamp = new Date().toISOString();
  const id = Math.random().toString(36).substring(2, 15);

  const log = {
    id,
    timestamp,
    request: requestData,
    response: responseData,
    error: error || null
  };

  const filename = `${timestamp.replace(/:/g, '-')}-${id}.json`;
  const filepath = path.join(getLogDir(), filename);

  fs.writeFileSync(filepath, JSON.stringify(log, null, 2), 'utf8');
  console.log(`日志已保存: ${filename}`);
}

// 更新状态栏文本
function updateStatusBarText(): void {
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const mainMapping = config.get<string>('mappings.main', 'pass');

  if (mainMapping === 'pass') {
    statusBarItem.text = '$(arrow-swap) Claude: 透传';
  } else {
    // 提取provider和model名称
    const parts = mainMapping.split(':');
    const modelName = parts.length > 1 ? parts[1] : mainMapping;
    statusBarItem.text = `$(arrow-swap) Claude: ${modelName}`;
  }

  statusBarItem.tooltip = '点击切换Main模型映射';
}

// 展开路径中的~为home目录
function expandPath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

// 启动LiteLLM进程
async function startLiteLLM(): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const enabled = config.get<boolean>('providers.litellm.enabled', false);

  if (!enabled) {
    return;
  }

  // 停止已有进程
  if (litellmProcess) {
    litellmProcess.kill();
    litellmProcess = null;
  }

  const binPath = expandPath(config.get<string>('providers.litellm.binPath', '~/.local/bin/litellm'));
  const port = config.get<number>('providers.litellm.port', 4100);
  const configPath = expandPath(config.get<string>('providers.litellm.configPath', '~/.claude/proxy/litellm.yaml'));

  // 检查配置文件是否存在
  if (!fs.existsSync(configPath)) {
    vscode.window.showWarningMessage(`LiteLLM配置文件不存在: ${configPath}`);
    console.warn(`LiteLLM配置文件不存在: ${configPath}`);
    return;
  }

  // 计算日志文件路径（将.yaml替换为.log）
  const logPath = configPath.replace(/\.yaml$/, '.log');

  console.log(`启动LiteLLM: ${binPath} --config ${configPath} --host 127.0.0.1 --port ${port}`);
  console.log(`日志文件: ${logPath}`);

  try {
    // 打开日志文件用于写入（追加模式）
    const logFd = fs.openSync(logPath, 'a');

    litellmProcess = spawn(binPath, [
      '--config', configPath,
      '--host', '127.0.0.1',
      '--port', port.toString(),
      '--debug'
    ], {
      cwd: path.dirname(configPath),
      stdio: ['ignore', logFd, logFd],
      detached: false
    });

    litellmProcess.on('error', (error) => {
      console.error('LiteLLM进程启动失败:', error);
      vscode.window.showErrorMessage(`LiteLLM启动失败: ${error.message}`);
      litellmProcess = null;
      try {
        fs.closeSync(logFd);
      } catch (e) {
        // 忽略关闭错误
      }
    });

    litellmProcess.on('exit', (code, signal) => {
      console.log(`LiteLLM进程退出: code=${code}, signal=${signal}`);
      litellmProcess = null;
      try {
        fs.closeSync(logFd);
      } catch (e) {
        // 忽略关闭错误
      }
    });

    vscode.window.showInformationMessage(`LiteLLM已启动 (端口: ${port}, 日志: ${logPath})`);
  } catch (error: any) {
    console.error('启动LiteLLM失败:', error);
    vscode.window.showErrorMessage(`启动LiteLLM失败: ${error.message}`);
  }
}

// 停止LiteLLM进程
function stopLiteLLM(): void {
  if (litellmProcess) {
    console.log('停止LiteLLM进程...');
    litellmProcess.kill();
    litellmProcess = null;
  }
}

// 启动CLIProxyAPI进程
async function startCLIProxyAPI(): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const enabled = config.get<boolean>('providers.cliproxyapi.enabled', false);

  if (!enabled) {
    return;
  }

  // 停止已有进程
  if (cliproxyapiProcess) {
    cliproxyapiProcess.kill();
    cliproxyapiProcess = null;
  }

  const binPath = expandPath(config.get<string>('providers.cliproxyapi.binPath', '~/cliproxyapi/cli-proxy-api'));
  const configPath = expandPath(config.get<string>('providers.cliproxyapi.configPath', '~/.claude/proxy/cliproxyapi.yaml'));
  const port = config.get<number>('providers.cliproxyapi.port', 4200);

  // 检查配置文件是否存在
  if (!fs.existsSync(configPath)) {
    vscode.window.showWarningMessage(`CLIProxyAPI配置文件不存在: ${configPath}`);
    console.warn(`CLIProxyAPI配置文件不存在: ${configPath}`);
    return;
  }

  // 计算日志文件路径（将.yaml替换为.log）
  const logPath = configPath.replace(/\.yaml$/, '.log');

  console.log(`启动CLIProxyAPI: ${binPath} --config ${configPath}`);
  console.log(`日志文件: ${logPath}`);

  try {
    // 打开日志文件用于写入（追加模式）
    const logFd = fs.openSync(logPath, 'a');

    cliproxyapiProcess = spawn(binPath, [
      '--config', configPath
    ], {
      cwd: path.dirname(configPath),
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PORT: port.toString() },
      detached: false
    });

    cliproxyapiProcess.on('error', (error) => {
      console.error('CLIProxyAPI进程启动失败:', error);
      vscode.window.showErrorMessage(`CLIProxyAPI启动失败: ${error.message}`);
      cliproxyapiProcess = null;
      try {
        fs.closeSync(logFd);
      } catch (e) {
        // 忽略关闭错误
      }
    });

    cliproxyapiProcess.on('exit', (code, signal) => {
      console.log(`CLIProxyAPI进程退出: code=${code}, signal=${signal}`);
      cliproxyapiProcess = null;
      try {
        fs.closeSync(logFd);
      } catch (e) {
        // 忽略关闭错误
      }
    });

    vscode.window.showInformationMessage(`CLIProxyAPI已启动 (端口: ${port}, 日志: ${logPath})`);
  } catch (error: any) {
    console.error('启动CLIProxyAPI失败:', error);
    vscode.window.showErrorMessage(`启动CLIProxyAPI失败: ${error.message}`);
  }
}

// 停止CLIProxyAPI进程
function stopCLIProxyAPI(): void {
  if (cliproxyapiProcess) {
    console.log('停止CLIProxyAPI进程...');
    cliproxyapiProcess.kill();
    cliproxyapiProcess = null;
  }
}

/**
 * 带重试的fetch请求,专用于CLIProxyAPI
 * 如果第一次失败,重启CLIProxyAPI并重试一次
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  provider: string
): Promise<Response> {
  try {
    return await fetch(url, options);
  } catch (error) {
    // 如果是CLIProxyAPI且请求失败,尝试重启并重试
    if (provider === 'cliproxyapi') {
      console.warn('[CLIProxyAPI] 第一次请求失败,尝试重启并重试...', error);

      // 重启CLIProxyAPI
      stopCLIProxyAPI();
      await startCLIProxyAPI();

      // 等待进程启动
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 重试请求
      try {
        return await fetch(url, options);
      } catch (retryError) {
        console.error('[CLIProxyAPI] 重试后仍然失败:', retryError);
        throw retryError;
      }
    }

    // 非CLIProxyAPI或其他情况,直接抛出错误
    throw error;
  }
}

// 过滤LiteLLM的空chunk
function filterLiteLLMChunk(chunk: Uint8Array): Uint8Array {
  const chunkStr = Buffer.from(chunk).toString('utf8');
  const lines = chunkStr.split('\n');
  const filteredLines: string[] = [];

  let shouldSkip = false;
  let currentEvent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 检测事件类型
    if (line.startsWith('event:')) {
      currentEvent = line.substring(6).trim();
      shouldSkip = false;
    }

    // 检测data行
    if (line.startsWith('data:')) {
      const dataStr = line.substring(5).trim();
      try {
        const data = JSON.parse(dataStr);

        // 过滤空的tool_use块
        if (currentEvent === 'content_block_start' &&
            data?.content_block?.type === 'tool_use' &&
            data?.content_block?.input &&
            Object.keys(data.content_block.input).length === 0) {
          shouldSkip = true;
          continue;
        }

        // 过滤空的text块
        if (currentEvent === 'content_block_start' &&
            data?.content_block?.type === 'text' &&
            data?.content_block?.text === '') {
          shouldSkip = true;
          continue;
        }
      } catch (e) {
        // JSON解析失败,保留原始行
      }
    }

    // 如果不应该跳过,添加到结果中
    if (!shouldSkip) {
      filteredLines.push(line);
    }

    // 空行表示事件结束
    if (line === '' && !shouldSkip) {
      currentEvent = '';
    }
  }

  return Buffer.from(filteredLines.join('\n'), 'utf8');
}

/**
 * 启动/重载时配置检查
 * 检查当前透传模式状态与配置文件是否一致，不一致则自动同步
 */
async function checkConfigurationOnStartup(): Promise<void> {
  const workspaceInfo = getSettingsInfo('workspace');
  const globalInfo = getSettingsInfo('global');

  // 两者都不存在时提示
  if (!workspaceInfo.exists && !globalInfo.exists) {
    vscode.window.showWarningMessage(
      '未找到 Claude 配置文件（~/.claude/settings.json 或项目/.claude/settings.json），代理设置无法生效。'
    );
    return;
  }

  // 检测当前激活的配置源和配置状态
  const activeScope = detectActiveSettingsScope();
  const activeInfo = getSettingsInfo(activeScope);

  // 获取当前 VSCode 扩展的透传模式配置
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const mainMapping = config.get<string>('mappings.main', 'pass');
  // const haikuMapping = config.get<string>('mappings.haiku', 'pass');

  // 关键修正：系统级的代理模式仅由 Main 模型决定
  // 如果 Main 是 pass，则系统处于透传模式（无论 Haiku 如何设置）
  const isPassThrough = mainMapping === 'pass';

  // 如果配置状态不一致，自动同步
  if (isPassThrough) {
    // 扩展配置是透传，确保移除所有代理配置
    // 检查是否有任何配置存在代理设置
    const workspaceInfo = getSettingsInfo('workspace');
    const globalInfo = getSettingsInfo('global');
    const hasAnyProxy = workspaceInfo.hasProxyConfig || globalInfo.hasProxyConfig;

    if (hasAnyProxy) {
      // 这里的 setPassThroughMode 会清理 workspace 和 global
      setPassThroughMode();
      console.log('检测到透传模式(Main=pass)，已强制移除配置文件中的代理设置');
    }
  } else if (!isPassThrough && !activeInfo.hasProxyConfig) {
    // 扩展配置是非透传，但配置文件中无代理配置，添加它
    updateProxyConfig(activeScope, true);
    console.log('检测到代理模式(Main!=pass)，已在配置文件中设置代理');
  }
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Claude Proxy 激活中...');

  // 启动时配置检查
  await checkConfigurationOnStartup();

  // 清理旧的日志文件
  cleanupOldLogs();

  // 创建状态栏按钮
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeProxy.selectMainMapping';
  updateStatusBarText();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 监听配置变化,更新状态栏文本
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeProxy.mappings.main')) {
        updateStatusBarText();
      }
    })
  );

  // 创建简单的透传代理服务器
  server = http.createServer(async (req, res) => {
    // 只处理POST请求
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    console.log(`收到请求: ${req.method} ${req.url}`);

    // 收集请求体
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));

    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      let requestBody: any = null;

      // 解析请求体
      try {
        requestBody = JSON.parse(body.toString('utf8'));
      } catch (e) {
        // 非JSON请求体
      }

      // 默认配置(透传)
      let targetUrl = `https://api.anthropic.com${req.url}`;
      let targetBody = body;
      let targetHeaders: any = {};
      let mappingInfo: any = null;
      let currentProvider: string = 'pass';  // 用于重试逻辑

      // 如果请求体包含model字段,检查是否需要映射
      if (requestBody && requestBody.model) {
        const originalModel = requestBody.model;
        const modelType = extractModelType(originalModel);

        console.log(`原始模型: ${originalModel}, 类型: ${modelType}`);

        // 获取目标配置
        const targetConfig = await getTargetConfig(modelType);

        if (targetConfig) {
          // 需要映射
          console.log(`映射到: ${targetConfig.endpoint}, 模型: ${targetConfig.model}`);

          // 提取provider名称
          const config = vscode.workspace.getConfiguration('claudeProxy');
          const mapping = config.get<string>(`mappings.${modelType}`, 'pass');
          if (mapping !== 'pass') {
            const parts = mapping.split(':');
            currentProvider = parts[0];
          }

          // 记录映射信息
          mappingInfo = {
            originalModel,
            targetModel: targetConfig.model,
            endpoint: targetConfig.endpoint,
            modelType,
            provider: currentProvider
          };

          // 修改请求体中的模型
          if (targetConfig.model) {
            requestBody.model = targetConfig.model;
            targetBody = Buffer.from(JSON.stringify(requestBody), 'utf8');
          }

          // 设置目标URL
          targetUrl = `${targetConfig.endpoint}${req.url}`;

          // 设置认证
          if (targetConfig.apiKey) {
            if (targetConfig.authMethod === 'x-api-key') {
              targetHeaders['x-api-key'] = targetConfig.apiKey;
            } else if (targetConfig.authMethod === 'token') {
              targetHeaders['authorization'] = `Bearer ${targetConfig.apiKey}`;
            }
          }
        } else {
          console.log('使用透传模式');
        }
      }

      console.log(`转发到: ${targetUrl}`);

      try {
        // 准备请求头
        const forwardHeaders: any = { ...targetHeaders };
        for (const [key, value] of Object.entries(req.headers)) {
          const lowerKey = key.toLowerCase();
          // 跳过host和connection等代理相关的头
          if (['host', 'connection', 'content-length'].includes(lowerKey)) {
            continue;
          }
          // 如果已经在targetHeaders中设置了认证,跳过原始认证头
          if ((lowerKey === 'x-api-key' || lowerKey === 'authorization') &&
              (targetHeaders['x-api-key'] || targetHeaders['authorization'])) {
            continue;
          }
          forwardHeaders[key] = value;
        }

        const response = await fetchWithRetry(targetUrl, {
          method: 'POST',
          headers: forwardHeaders,
          body: targetBody
        }, currentProvider);

        // 收集响应数据用于日志
        const responseChunks: Uint8Array[] = [];

        // 复制响应头 - 转发所有必要的头部
        const responseHeaders: any = {};
        for (const [key, value] of response.headers.entries()) {
          const lowerKey = key.toLowerCase();
          // 跳过一些不应该转发的头部
          if (['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(lowerKey)) {
            continue;
          }
          responseHeaders[key] = value;
        }

        // 确保有 content-type
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'application/json';
        }

        res.writeHead(response.status, responseHeaders);

        // 流式转发响应并收集数据
        const reader = response.body?.getReader();
        // 只对LiteLLM provider应用空chunk过滤
        const shouldFilterEmptyChunks = currentProvider === 'litellm';

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // 如果是LiteLLM,过滤空chunk
            let processedValue = value;
            if (shouldFilterEmptyChunks) {
              processedValue = filterLiteLLMChunk(value);
              // 如果过滤后为空,跳过
              if (processedValue.length === 0) {
                continue;
              }
            }

            responseChunks.push(processedValue);
            res.write(processedValue);
          }
        }

        res.end();
        console.log(`请求完成: ${response.status}`);

        // 保存日志 - 记录实际发送的内容
        const responseText = Buffer.concat(responseChunks).toString('utf8');
        let responseBody: any = null;

        // 尝试解析响应
        try {
          // 先尝试直接解析JSON
          responseBody = JSON.parse(responseText);
        } catch (e) {
          // 可能是流式响应,尝试解析SSE格式
          if (responseText.includes('data:')) {
            // 提取所有data块并尝试合并
            const dataLines = responseText.split('\n')
              .filter(line => line.startsWith('data: '))
              .map(line => line.substring(6));

            // 尝试解析每个data块
            const parsedChunks = [];
            for (const dataLine of dataLines) {
              if (dataLine.trim() === '[DONE]') continue;
              try {
                parsedChunks.push(JSON.parse(dataLine));
              } catch (e2) {
                // 忽略解析失败的块
              }
            }

            if (parsedChunks.length > 0) {
              responseBody = {
                isStreaming: true,
                chunks: parsedChunks,
                rawText: responseText
              };
            } else {
              responseBody = responseText;
            }
          } else {
            responseBody = responseText;
          }
        }

        await saveLog(
          {
            url: req.url,
            method: req.method,
            headers: forwardHeaders,  // 使用实际发送的headers
            body: requestBody,  // 使用修改后的body(如果有映射)
            mapping: mappingInfo  // 添加映射信息
          },
          {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseBody
          }
        );

      } catch (error: any) {
        console.error('代理错误:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));

        // 保存错误日志
        await saveLog(
          {
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: requestBody
          },
          null,
          error.message
        );
      }
    });
  });

  // 从配置读取端口
  const config = vscode.workspace.getConfiguration('claudeProxy');
  const port = config.get<number>('port', 4001);

  // 启动服务器
  server.listen(port, '127.0.0.1', () => {
    console.log(`✓ 代理服务器启动在 http://127.0.0.1:${port}`);
    vscode.window.showInformationMessage(`Claude Proxy 已启动 (端口: ${port})`);
  });

  // 监听端口占用错误
  server.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 已被占用,跳过启动代理服务器`);
      server = null;
    } else {
      console.error('服务器错误:', error);
      vscode.window.showErrorMessage(`代理服务器启动失败: ${error.message}`);
    }
  });

  // 启动LiteLLM进程
  await startLiteLLM();

  // 启动CLIProxyAPI进程
  await startCLIProxyAPI();

  // 注册命令: 选择Haiku映射
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.selectHaikuMapping', async () => {
      await selectMapping('haiku');
    })
  );

  // 注册命令: 选择Main映射
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeProxy.selectMainMapping', async () => {
      await selectMapping('main');
    })
  );

  // 监听配置变化,重启LiteLLM
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('claudeProxy.providers.litellm')) {
        console.log('LiteLLM配置已更改,重启进程...');
        stopLiteLLM();
        await startLiteLLM();
      }
      if (e.affectsConfiguration('claudeProxy.providers.cliproxyapi')) {
        console.log('CLIProxyAPI配置已更改,重启进程...');
        stopCLIProxyAPI();
        await startCLIProxyAPI();
      }
    })
  );

  // 注册清理函数
  context.subscriptions.push({
    dispose: () => {
      if (server) {
        server.close();
        console.log('✓ 代理服务器已关闭');
      }
      stopLiteLLM();
      stopCLIProxyAPI();
    }
  });
}

/**
 * 选择映射目标
 */
async function selectMapping(modelType: 'haiku' | 'main'): Promise<void> {
  const config = vscode.workspace.getConfiguration('claudeProxy');

  // 收集所有可用的目标
  const targets: string[] = ['pass'];

  // 添加Anthropic provider的模型
  const anthropicEnabled = config.get<boolean>('providers.anthropic.enabled', false);
  if (anthropicEnabled) {
    const anthropicModels = config.get<string[]>('providers.anthropic.models', []);
    for (const model of anthropicModels) {
      targets.push(`anthropic:${model}`);
    }
  }

  // 添加GLM provider的模型
  const glmEnabled = config.get<boolean>('providers.glm.enabled', false);
  if (glmEnabled) {
    const glmModels = config.get<string[]>('providers.glm.models', []);
    for (const model of glmModels) {
      targets.push(`glm:${model}`);
    }
  }

  // 添加Kimi provider的模型
  const kimiEnabled = config.get<boolean>('providers.kimi.enabled', false);
  if (kimiEnabled) {
    const kimiModels = config.get<string[]>('providers.kimi.models', []);
    for (const model of kimiModels) {
      targets.push(`kimi:${model}`);
    }
  }

  // 添加MiniMax provider的模型
  const minimaxEnabled = config.get<boolean>('providers.minimax.enabled', false);
  if (minimaxEnabled) {
    const minimaxModels = config.get<string[]>('providers.minimax.models', []);
    for (const model of minimaxModels) {
      targets.push(`minimax:${model}`);
    }
  }

  // 添加DeepSeek provider的模型
  const deepseekEnabled = config.get<boolean>('providers.deepseek.enabled', false);
  if (deepseekEnabled) {
    const deepseekModels = config.get<string[]>('providers.deepseek.models', []);
    for (const model of deepseekModels) {
      targets.push(`deepseek:${model}`);
    }
  }

  // 添加自定义Provider的模型
  const customEnabled = config.get<boolean>('providers.custom.enabled', false);
  if (customEnabled) {
    const customModels = config.get<string[]>('providers.custom.models', []);
    for (const model of customModels) {
      targets.push(`custom:${model}`);
    }
  }

  // 添加LiteLLM provider的模型
  const litellmEnabled = config.get<boolean>('providers.litellm.enabled', false);
  if (litellmEnabled) {
    const litellmModels = config.get<string[]>('providers.litellm.models', []);
    for (const model of litellmModels) {
      targets.push(`litellm:${model}`);
    }
  }

  // 添加CLIProxyAPI provider的模型
  const cliproxyapiEnabled = config.get<boolean>('providers.cliproxyapi.enabled', false);
  if (cliproxyapiEnabled) {
    const cliproxyapiModels = config.get<string[]>('providers.cliproxyapi.models', []);
    for (const model of cliproxyapiModels) {
      targets.push(`cliproxyapi:${model}`);
    }
  }

  // 获取当前映射
  const currentMapping = config.get<string>(`mappings.${modelType}`, 'pass');

  // 创建QuickPick选项
  const items = targets.map(target => ({
    label: target === currentMapping ? `$(check) ${target}` : target,
    description: target === 'pass' ? '透传,不修改' : '',
    picked: target === currentMapping
  }));

  // 显示选择框
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `选择${modelType === 'haiku' ? 'Haiku' : 'Main(Sonnet/Opus)'}模型的映射目标`
  });

  if (selected) {
    const targetValue = selected.label.replace(/^\$\(check\)\s+/, '');
    const previousMapping = config.get<string>(`mappings.${modelType}`, 'pass');

    await config.update(`mappings.${modelType}`, targetValue, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`${modelType}映射已更新为: ${targetValue}`);

    // 计算新的主模型映射状态
    // 如果当前修改的是 main，则使用新的 targetValue
    // 如果当前修改的是 haiku，则保持 main 的配置不变
    const currentMainMapping = config.get<string>('mappings.main', 'pass');
    const newMainMapping = modelType === 'main' ? targetValue : currentMainMapping;

    // 只有当 Main 模型不是 'pass' 时，才启用代理模式
    // 如果 Main 是 'pass'，强制使用透传模式（忽略 Haiku 的设置）
    const shouldEnableProxy = newMainMapping !== 'pass';

    if (!shouldEnableProxy) {
      // 目标是透传模式 (Main == pass)
      // 检查任何作用域是否存在代理配置
      const workspaceInfo = getSettingsInfo('workspace');
      const globalInfo = getSettingsInfo('global');
      const anyHasProxy = workspaceInfo.hasProxyConfig || globalInfo.hasProxyConfig;

      if (anyHasProxy) {
         console.log('Main模型为透传，强制切换到系统透传模式');
         setPassThroughMode();
         vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } else {
      // 目标是代理模式 (Main != pass)
      // 如果当前激活的作用域没有配置代理，则添加
      const activeScope = detectActiveSettingsScope();
      const activeInfo = getSettingsInfo(activeScope);

      if (!activeInfo.hasProxyConfig) {
         console.log('Main模型需要映射，强制切换到系统代理模式');
         setProxyMode();
         vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }

    // 如果是main模型,更新状态栏
    if (modelType === 'main') {
      updateStatusBarText();
    }
  }
}

export function deactivate() {
  if (server) {
    server.close();
  }
}
