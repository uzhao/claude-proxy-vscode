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

  console.log(`启动LiteLLM: ${binPath} --config ${configPath} --host 127.0.0.1 --port ${port}`);

  try {
    litellmProcess = spawn(binPath, [
      '--config', configPath,
      '--host', '127.0.0.1',
      '--port', port.toString()
    ], {
      cwd: path.dirname(configPath),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // 监听输出
    litellmProcess.stdout?.on('data', (data) => {
      console.log(`[LiteLLM] ${data.toString().trim()}`);
    });

    litellmProcess.stderr?.on('data', (data) => {
      console.error(`[LiteLLM Error] ${data.toString().trim()}`);
    });

    litellmProcess.on('error', (error) => {
      console.error('LiteLLM进程启动失败:', error);
      vscode.window.showErrorMessage(`LiteLLM启动失败: ${error.message}`);
      litellmProcess = null;
    });

    litellmProcess.on('exit', (code, signal) => {
      console.log(`LiteLLM进程退出: code=${code}, signal=${signal}`);
      litellmProcess = null;
    });

    vscode.window.showInformationMessage(`LiteLLM已启动 (端口: ${port})`);
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

  console.log(`启动CLIProxyAPI: ${binPath} --config ${configPath}`);

  try {
    cliproxyapiProcess = spawn(binPath, [
      '--config', configPath
    ], {
      cwd: path.dirname(configPath),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: port.toString() }
    });

    // 监听输出
    cliproxyapiProcess.stdout?.on('data', (data) => {
      console.log(`[CLIProxyAPI] ${data.toString().trim()}`);
    });

    cliproxyapiProcess.stderr?.on('data', (data) => {
      console.error(`[CLIProxyAPI Error] ${data.toString().trim()}`);
    });

    cliproxyapiProcess.on('error', (error) => {
      console.error('CLIProxyAPI进程启动失败:', error);
      vscode.window.showErrorMessage(`CLIProxyAPI启动失败: ${error.message}`);
      cliproxyapiProcess = null;
    });

    cliproxyapiProcess.on('exit', (code, signal) => {
      console.log(`CLIProxyAPI进程退出: code=${code}, signal=${signal}`);
      cliproxyapiProcess = null;
    });

    vscode.window.showInformationMessage(`CLIProxyAPI已启动 (端口: ${port})`);
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

export async function activate(context: vscode.ExtensionContext) {
  console.log('Claude Proxy 激活中...');

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

        // 复制响应头
        res.writeHead(response.status, {
          'content-type': response.headers.get('content-type') || 'application/json',
        });

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
    await config.update(`mappings.${modelType}`, targetValue, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`${modelType}映射已更新为: ${targetValue}`);

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
