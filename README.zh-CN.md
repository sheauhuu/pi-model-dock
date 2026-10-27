# pi-model-dock

[English](README.md)

为 Pi 和 Oh My Pi (OMP) 管理自定义 provider 的更好方式。

一个交互式向导(`/provider`),用于添加、编辑、删除自定义 LLM
provider——无需手工编辑配置文件。

## 来源与独立维护

pi-model-dock 基于
[real-wudaoshi/better-custom](https://github.com/real-wudaoshi/better-custom)
独立维护;该上游源自
[ratatulieoi/better-custom](https://github.com/ratatulieoi/better-custom)。
本项目通过完整 Git clone 创建,保留上游历史,未使用 GitHub Fork。
导入基线为 `84e9daff2b2211af71034187415fcd273721942e`(61 个提交)。
[LICENSE](LICENSE) 中的 MIT 许可证及 ratatulieoi、real-wudaoshi
的原始版权声明均原样保留。

独立仓库配置为 `origin`(`git@github.com:sheauhuu/pi-model-dock.git`),
原仓库配置为 `upstream`(`https://github.com/real-wudaoshi/better-custom.git`)。
本项目尚未发布 npm 包。包版本 `1.6.0` 沿用上游,
不代表已经发布独立的 npm 版本。

初始导入保留上游行为;独立开发现已增加 provider 显示名称、能力来源、
完整思考档位和持久化使用限制,独立入口为 `/provider`。原始架构、检查结果与暂缓的优化建议见
[初始评审](docs/INITIAL_REVIEW.md)。

## 功能特性

- **从 [models.dev](https://models.dev) 目录添加** —— 直接挑选已知 API
  站点(OpenRouter、DeepSeek、Groq、xAI 等);base URL、模型列表、元数据
  全部来自目录(官方 SDK 共用一次读取和缓存,内置离线快照回退),完全不探测。
- **添加任意自定义端点** —— 支持 OpenAI Chat Completions、OpenAI
  Responses、Anthropic Messages、Gemini、Ollama。自动探测会查询 `/models`
  和所有已知元数据来源;也可以手动输入(逐个模型,进入各自的元数据菜单,
  各项以解析结果为起点)。
- **自动检测模型元数据** —— 上下文窗口、最大输出 token、image/video 输入、
  reasoning 支持/档位,直接从网关本身(LiteLLM `/model/info` +
  `/model_group/info`、站点公开目录、OpenAI `GET /models/{id}`、列表内联
  元数据、Ollama 原生 API)和 models.dev 学习。见
  [元数据如何解析](#元数据如何解析)。
- **重新探测并对账** —— 再次查询 `/models`,在一个三态列表里统一处理:
  新模型、元数据更新(`context 128000 -> 1000000`、`image [+]`、
  `max-out 8192 -> 32000`)、端点不再返回的模型(标记 `unsupported`)。
  `[x]` 应用、`[-]` 保留已存元数据、`[ ]` 移除/跳过。
- **事后一切可改** —— 逐模型字段(支持的思考档位、图像输入、上下文窗口、
  最大输出 token、headers/端点覆盖)、批量删除模型、provider 的 API
  flavor、端点、重命名、删除。
- **区分未知与不支持** —— 缺失字段按项从参考目录和本地规则补全,
  显示具体来源。自动补全保留网关明确的 `false`;所有来源都没有的字段
  继续显示未知。
- **持久化使用限制** —— 上下文支持 272K 等快捷选项、参考值和自定义值。
  刷新和重启保留手动选择;选择 Auto 恢复自动值。
- **developer role 探测** —— 拒绝 OpenAI `developer` 角色的端点(比如
  Kimi 订阅端点)会自动写入 `compat.supportsDeveloperRole: false`,pi 就会
  继续发 `system` 而不是报 400。
- **官方风格的存储** —— API key 写入 `~/.pi/agent/auth.json`(就是
  `/login` 写的那个文件),模型声明写入 `models.json`。旧版内联的
  `apiKey` 自动迁移。见[存储](#存储)。
- **完整思考档位** —— 自动识别或手动复选声明支持的档位,实际使用档位在
  Pi 的 `/thinking` 中选择。手动声明在刷新时保留。不支持的档位设为 `null`;元数据未知
  时不会自动开放 `xhigh`、`max`。
- **模型显示名称** —— 保留网关、models.dev 或本地目录中的模型名称用于
  显示和搜索。手动名称在刷新时保留;模型 API id 的大小写始终原样保留。
- **路径自适应探测** —— `/models` 在给定 base 上没响应时自动尝试加/去
  `/v1` 的变体;非本地 `http://` 自动回退 `https://`。失败后可以重试或改
  手动输入。

## 安装

```bash
pi install /path/to/pi-model-dock            # 从当前本地检出安装
```

独立仓库发布后,可使用
`pi install https://github.com/sheauhuu/pi-model-dock` 安装。
计划使用的 npm 包名为 `pi-model-dock`;本地准备阶段尚未发布该包。

建议用 `pi install`,而不是手动把文件夹复制到 `~/.pi/agent/extensions/`:
`pi install` 会执行 `npm install`,运行时依赖(`@opencode-ai/models`、`model-probe`、`yaml`)
才会装好。手动复制也能启动,但 YAML 配置会退化为 JSON(JSON 是合法的
YAML 子集)。

## 使用方法

在 pi 中运行 `/provider`,然后选择 **添加 provider**、
**编辑 provider** 或 **删除 provider**。

Provider 名称保留输入的拼写:输入 `AxonHub` 时,使用小写 `axonhub`
作为 provider id,另存 `name: "AxonHub"` 用于显示。名称与 id 相同时
省略 `name` 字段。列表显示 `AxonHub (axonhub)`,名称和 id 均可搜索;
已有配置未设置 `name` 时仍显示 id。

模型同样支持独立的 `name`,例如 `id: "gpt-6.1-sol"` 搭配
`name: "GPT-6.1-Sol"`。模型 id 会原样发送给 API,不强制转小写。
**Display name** 提供 Auto、Custom、Use model id。自动名称优先读取
网关的 `display_name` / `displayName` / 显示用 `name`,再参考目录。
列表同时显示并支持搜索名称和 id。旧条目在应用 Refresh 或在名称菜单
选择 Auto 后写入名称;仅浏览页面不会自动改名。

### 添加

1. **从 models.dev 目录添加** —— 挑选 provider、命名、输入 API key(或
   选 none)、多选模型。元数据全部来自目录。
2. **自定义端点** —— 选择 provider 类型,输入端点地址、名称、API key,
   然后:
   - **自动探测** —— 探测 `/models` + 元数据来源,多选模型并内联显示
     元数据;或
   - **手动添加** —— 输入 id,进入该模型的元数据菜单(reasoning / 图像
     输入 / 上下文窗口 / 最大输出 token),确认后输入下一个 id;留空或
     esc 结束。

### 编辑

选择一个 provider,然后:**重新探测模型**(如上对账)、**逐模型编辑**、
**删除模型**(批量)、**手动添加模型**、**API flavor**、**Endpoint**、
**重命名 provider**、**删除 provider**。

逐模型编辑只原地修改单个字段——未触碰的字段(cost、headers、覆盖项)
都会保留。

**Context window** 点击后提供 Auto、探测/参考值、常用使用限制(含
272,000 tokens)和 Custom。手动选择会跨刷新、重启保留,选择 Auto
移除手动覆盖。界面分别显示实际配置预算和探测到的容量;Pi 的预算限制
不会改变网关的计费规则。

**Supported thinking levels** 提供 Auto 和 Manual。Manual 进入复选框:
空格切换、Enter 保存(至少一项)、Escape 取消。已知档位会预先勾选,
未知模型默认不勾选。选择 `low / high / max` 会生成完整映射,禁用
`off`、`minimal`、`medium`、`xhigh`。这属于手动能力声明,不会发送请求
验证。刷新更新观测资料,保留手动声明;切回 Auto 才使用最新自动资料。

实际使用哪个思考档位,在 Pi 的 `/thinking` 中选择,插件不再额外设置使用上限。
旧的上限偏好不再生效;已有配置里被限制的档位,通过 Refresh 或重新选择支持档位更新。

**Refresh metadata** 可查询网关并补全缺失项,或明确选用 models.dev /
本地 Pi 模型目录中的参考条目。应用前展示字段和档位差异。手动限制独立
保留,包括手动模型名称和档位声明;来源未提供的字段不会清空已有配置。旧配置没有手动偏好记录时,
刷新先展示差异;通过新菜单手动选择一次,即可持久化保留该值。

**重命名 provider** 同样保留拼写。仅改变大小写时,只更新显示名称,
id 和凭证保持原位;派生出的 id 改变时,沿用原有凭证迁移行为。

## 元数据如何解析

每个字段独立解析,按以下优先级补全:

1. **网关声明** —— `/models` 列表、逐模型详情和网关级元数据。
   支持 `modalities.input`、对象/数组形式的 capabilities,以及字符串
   或 `{ effort }` 形式的思考档位。网关级结果不完整时仍查询缺失详情。
2. **models.dev** —— 优先匹配端点,再跨 provider 检索归一化后的同名
   模型,优先模型厂商的条目。
3. **本地 Pi 模型目录** —— 从运行中的宿主查找同名模型,标出参考
   provider。排除配置里的自定义 provider,避免用旧配置给自己作证。
4. **本地规则** —— 复用 `model-probe` 的型号规则,明确标为推测。
5. **未知** —— 图片、思考、上下文、输出限制或档位均可能保持未知。
   新模型必须生成可加载的运行配置时,未知图片暂按纯文本、未知思考暂按
   关闭处理;这些兜底不会记录为“不支持”的能力证据。

自动补全不会用低优先级猜测替换网关明确的 `false`。明确选择 Refresh
参考源时,会先展示该参考的更新差异。不同来源的上下文值保留为带来源的
快捷选项,不超过已知的网关上限。即使 `reasoning` 仍为 `true`,完整档位
变化也会更新;规则猜测不会在刷新时覆盖已有字段。视频保留在能力信息中,
但 Pi 模型配置仅写其支持的 text/image 输入字段。

### 价格估计

当网关自身上报价格(LiteLLM 的 `input_cost_per_token` 等、OpenRouter 的
内联 `pricing`),或模型命中 models.dev 目录条目时,扩展会把 pi 的
`cost` 字段(每百万 token 美元价:input / output / cacheRead /
cacheWrite)写进模型条目——和内置 provider 自带的字段一致——这样 pi 的
用量统计也能给自定义 provider 估算会话成本。价格绝不猜测:没有本地规则,
没有默认值。中转网关显示的价格是官方标价,可能与中转实际计费不同。

## 存储

Pi(官方拆分方式,和 `/login` 一致):

- `~/.pi/agent/auth.json` —— 凭证,以 provider id 为键
  (`{"type": "api_key", "key": ...}`);`$ENV` / `!command` 引用有效。
  pi 对任意 provider id 都会自动解析。选择 none 会写入 `"dummy"` /
  `"ollama"` 占位符,provider 仍可正常加载。
- `~/.pi/agent/models.json` —— provider 声明(baseUrl、api、compat、
  models)。pi 只从 `models.json` 加载自定义 provider;`models-store.json`
  是 pi 内部给内置 provider 用的目录缓存,不适合存放自定义模型。
- `~/.pi/agent/pi-model-dock.json` —— 按 provider / model 保存能力快照、
  字段来源和明确的手动偏好,不保存凭证、端点或 headers。删除模型/
  provider 时清理记录,provider id 改变时同步迁移。手动模型名称和档位
  声明属于偏好,不会替换保存的自动观测资料。
- 旧版内联的 `apiKey` 会在下次保存时自动迁移到 `auth.json`;删除
  provider 会一并删除其 `auth.json` 条目,重命名会同步迁移。

### 内置 id 撞车

把自定义 provider 命名为 pi 的内置 provider id(比如 `deepseek`、
`openai`)**不会**覆盖内置 provider——pi 会把两者合并:内置模型目录
始终可见,即便你在这里删掉那些模型;而 `auth.json` 以 id 为键,对内置
provider 执行 `/login`、`/logout` 会同时读取/清掉你的 key。添加或重命名为
撞车 id 时,扩展会提供一键改成 `<id>-custom` 的选项(故意扩展内置
provider 时仍可保留撞车),删除模型的确认框也会标明合并行为;provider
列表里撞车的 id 带 `⚠ built-in id` 后缀。如果故意保持撞车,可以用
pi-hide-providers 的 `/hide-models` 隐藏不想看到的内置目录模型。

OMP:provider 和密钥保持内联在 `models.yml` / `models.yaml`(已有文件
保持原格式,新建配置为 `models.yml`)。保存 YAML 会重写格式、丢弃注释。

## 开发

纯 TypeScript,由 pi 直接加载,无需构建步骤。网关列表/详情解析及能力、
偏好逻辑由本项目维护;网关级探测、限制规范化和型号规则复用
[model-probe](https://github.com/real-wudaoshi/model-probe),不修改
`node_modules` 中的依赖。

```bash
npm install     # 安装运行时依赖
npm run check   # 原有语法检查及新增功能模块
npm test        # 隔离验证能力、偏好、刷新和名称流程
```

继承的 `check` 脚本目前漏掉 `src/presets.ts`,仅检查语法。
项目尚无全量类型检查或 CI 配置。测试使用 Node 的 TypeScript stripping
和 VM modules,配合脱敏元数据、内存宿主/UI 适配和临时偏好文件,不使用
真实凭证或模型生成接口。开发测试基线为 Node.js 24,本次使用
24.12.0 验证;声明的最低 Node.js 版本与语法检查命令有待统一,
详见初始评审。另外尝试对照已安装宿主进行临时类型检查,仅报告上游
`model-probe/src/modelsdev.ts` 与其 models.dev SDK 的已有类型错误;
本轮未修改依赖。

结构:`index.ts`(命令入口)· `src/flows/`(add / edit / delete /
shared)· `src/ui/`(选择器、提示)· `src/config.ts`(models.json +
auth.json 读写、迁移)· `src/model-entry.ts`(模型/provider 配置构建)·
`src/provider-name.ts`(显示名称与 id)· `src/api-key.ts`、`src/url.ts`、
`src/presets.ts`(辅助)。能力相关模块为 `src/gateway-metadata.ts`、
`src/capabilities.ts`、`src/model-catalog.ts`、`src/model-settings.ts`、
`src/model-state.ts`;`src/model-name.ts` 处理模型显示标签。provider 列表、
模型名称与能力共用官方 `@opencode-ai/models` 客户端的一份目录缓存,
离线时回退到其内置快照。

## 许可证

MIT
