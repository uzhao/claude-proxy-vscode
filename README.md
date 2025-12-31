# Claude Proxy

一个轻量级的 VSCode 扩展,为 Claude API 提供智能代理和模型切换服务。

## ✨ 功能特性

### 🔄 支持多个 AI 服务提供商

- **Anthropic 官方 API** - Claude 官方 API
- **GLM (智谱AI)** - 国内可用的 Claude 兼容 API
- **Kimi (Moonshot)** - Moonshot AI 的 Claude 兼容 API
- **MiniMax** - MiniMax 的 Claude 兼容 API
- **DeepSeek** - DeepSeek 的 Claude 兼容 API
- **自定义 Provider** - 支持任何 Anthropic 格式兼容的 API
- **LiteLLM** - 本地代理,支持转换调用其他 LLM
- **CLIProxyAPI** - 本地代理,支持复杂的模型路由

### ⚙️ 灵活的模型映射

- **Haiku 模型映射** - 在设置中配置
- **Main 模型映射** - 通过状态栏快速切换(Sonnet/Opus)

### 📝 可选的请求日志

- 将所有请求和响应保存为 JSON 文件到 `~/.claude/proxy/log/`
- 方便调试和分析 API 调用

## 📦 安装

在 VSCode 扩展市场搜索 "Claude Proxy" 或访问 [扩展页面](https://marketplace.visualstudio.com/items?itemName=uzhao.claude-proxy) 安装。

## 🚀 快速开始

### 1. 基础配置

安装后,扩展会自动启动代理服务器(默认端口 4001)。

### 2. 配置 Provider

打开 VSCode 设置(`Ctrl+,` 或 `Cmd+,`),搜索 "Claude Proxy",根据需要配置一个或多个 Provider:

**示例:配置 GLM (智谱AI)**

1. 启用 `Claude Proxy › Providers › GLM › Enabled`
2. 填写 `Claude Proxy › Providers › GLM › API Key` 为你的 API 密钥
3. 在 `Claude Proxy › Providers › GLM › Models` 中添加可用模型,例如:
   ```json
   [
     "glm-4-plus",
     "glm-4-flash"
   ]
   ```

### 3. 修改 Haiku 模型映射

Haiku 模型的映射通过**设置**配置:

1. 打开设置,搜索 `Claude Proxy › Mappings › Haiku`
2. 从下拉列表选择映射目标,或手动输入 `provider:model` 格式
   - 例如: `glm:glm-4-flash`
   - 或保持 `pass` 表示透传

也可以通过命令面板:
- 按 `Ctrl+Shift+P` (或 `Cmd+Shift+P`)
- 输入 `Claude Proxy: 选择Haiku映射目标`
- 从列表中选择

### 4. 修改主要模型映射(Sonnet/Opus)

主要模型(Main)的映射通过**状态栏**快速切换:

1. 点击右下角状态栏的 `$(arrow-swap) Claude: xxx` 按钮
2. 从弹出的快速选择菜单中选择目标模型
   - 选择 `pass` 表示透传到原始 API
   - 选择 `provider:model` 格式的选项映射到对应模型

当前映射会实时显示在状态栏上。

## 🔧 工作原理

### 轻量级转发设计

Claude Proxy 采用轻量级的请求转发机制:

1. **本地代理服务器**: 在 `127.0.0.1:4001` 启动 HTTP 代理
2. **模型识别**: 根据请求中的模型名称(haiku/sonnet/opus)自动识别类型
3. **智能路由**: 根据配置的映射规则,将请求转发到对应的 Provider
4. **流式转发**: 支持 SSE 流式响应,保持实时性

### 优先原生格式

对于支持 **Anthropic 原生格式** 的 Provider(GLM、Kimi、MiniMax、DeepSeek、自定义 Provider):

- ✅ **直接转发** - 保持原始请求格式,仅修改 endpoint 和认证头
- ✅ **零开销** - 无需格式转换,性能最优
- ✅ **完全兼容** - 支持所有 Claude API 特性(tool use、vision 等)

### 借助成熟工具转换

对于**不支持 Anthropic 格式**的模型,通过集成成熟的转换工具:

- **LiteLLM** - 支持 100+ LLM 提供商,自动格式转换
  - 适合需要调用 OpenAI、Google Gemini 等其他 LLM 的场景
  - 需要单独安装并配置 LiteLLM

- **CLIProxyAPI** - 灵活的本地代理,支持复杂路由规则
  - 适合需要自定义转换逻辑的高级场景
  - 需要单独安装并配置

### 配置示例

**场景 1: 使用国内 GLM API(原生格式)**

```json
{
  "claudeProxy.mappings.main": "glm:glm-4-plus",
  "claudeProxy.providers.glm.enabled": true,
  "claudeProxy.providers.glm.apiKey": "your-api-key",
  "claudeProxy.providers.glm.models": ["glm-4-plus", "glm-4-flash"]
}
```

**场景 2: 通过 LiteLLM 调用 OpenAI**

```json
{
  "claudeProxy.mappings.main": "litellm:gpt-4",
  "claudeProxy.providers.litellm.enabled": true,
  "claudeProxy.providers.litellm.binPath": "~/.local/bin/litellm",
  "claudeProxy.providers.litellm.configPath": "~/.claude/proxy/litellm.yaml",
  "claudeProxy.providers.litellm.models": ["gpt-4", "gpt-3.5-turbo"]
}
```

## 📊 日志记录

启用 JSON 日志记录:

```json
{
  "claudeProxy.enableJsonLogging": true
}
```

日志会保存到 `~/.claude/proxy/log/` 目录,每个请求一个 JSON 文件,包含:
- 请求 URL、headers、body
- 响应 status、headers、body
- 模型映射信息
- 错误信息(如果有)

## ⚠️ 常见问题

### Q: 如何配置 Claude Code 使用代理?

将 Claude Code 的 API endpoint 设置为 `http://127.0.0.1:4001`:

```bash
# 在 ~/.claude/config.json 中配置
{
  "apiBaseUrl": "http://127.0.0.1:4001"
}
```

### Q: 为什么 LiteLLM 启动失败?

1. 确保已安装 LiteLLM: `pip install litellm`
2. 检查配置文件路径是否正确
3. 查看 VSCode 开发者控制台的错误信息

### Q: 如何查看代理日志?

- 开启 JSON 日志后,查看 `~/.claude/proxy/log/` 目录
- 或者打开 VSCode 的开发者控制台查看实时日志

### Q: 支持哪些 Claude API 特性?

对于原生格式的 Provider(GLM、Kimi 等),支持所有 Claude API 特性:
- ✅ 流式响应
- ✅ Tool Use (函数调用)
- ✅ Vision (图像理解)
- ✅ System Prompts
- ✅ 所有参数配置

对于通过 LiteLLM 等工具转换的模型,功能取决于目标模型的能力。

## 🛠️ 开发

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/uzhao/claude-proxy-vscode.git
cd claude-proxy-vscode

# 安装依赖
npm install

# 编译
npm run compile

# 在 VSCode 中按 F5 启动调试
```

### 监视模式

```bash
npm run watch
```

### 打包扩展

```bash
npm install -g @vscode/vsce
vsce package
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request!

## 📄 许可证

[MIT License](LICENSE)

## 🔗 相关链接

- [GitHub 仓库](https://github.com/uzhao/claude-proxy-vscode)
- [问题反馈](https://github.com/uzhao/claude-proxy-vscode/issues)
- [VSCode 扩展市场](https://marketplace.visualstudio.com/items?itemName=uzhao.claude-proxy)
