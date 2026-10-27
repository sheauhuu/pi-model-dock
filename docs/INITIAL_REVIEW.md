# pi-model-dock 初始评审

本文记录首次导入阶段的项目准备与代码评审。当前独立项目的入口已改为
`/provider`;下文的 `/custom-provider` 指导入时的上游入口。后续功能见 README。

## 来源与本地状态

- 来源:[real-wudaoshi/better-custom](https://github.com/real-wudaoshi/better-custom)。
- 完整 clone 基线:`84e9daff2b2211af71034187415fcd273721942e`,保留全部 61 个提交,非浅克隆,未使用 GitHub Fork。
- 保留当前目录已有的 `origin = git@github.com:sheauhuu/pi-model-dock.git`;原仓库配置为 `upstream`。
- 原 MIT 许可证及 ratatulieoi、real-wudaoshi 版权声明原样保留。
- 名称及包名改为 `pi-model-dock`,仓库元数据、安装说明和一处报错中的目录名称同步调整。
- 沿用版本 `1.6.0`、`/custom-provider` 命令、依赖范围及业务流程;未提交改名变更、未推送、未发布 npm 包。

## 架构与约定

这是 Pi / Oh My Pi 的扩展包,共 13 个 TypeScript 源文件、约 3,155 行,由宿主直接加载,没有独立服务或编译产物。
仓库没有 `AGENTS.md`、测试、类型检查配置、lint 配置或 CI 工作流。
现有代码采用 ESM、显式 `.ts` 导入、Tab 缩进,通过 `ctx.ui` 交互,多数流程在读写失败时通知并返回。

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 注册 `/custom-provider`,分发添加、编辑、删除 |
| `src/flows/add.ts` | models.dev 目录或自定义端点两条添加路径 |
| `src/flows/edit.ts` | provider / 模型编辑、重新探测、元数据刷新,855 行 |
| `src/flows/delete.ts`, `shared.ts` | 删除、共享持久化、注册表刷新、探测编排 |
| `src/ui/` | 搜索选择、二态/三态多选、字段输入 |
| `src/config.ts` | Pi / OMP 环境识别、JSON / YAML 读写、凭证迁移 |
| `src/model-entry.ts` | 元数据转换、reasoning 档位映射、配置构建 |
| `src/api-key.ts`, `url.ts`, `presets.ts`, `types.ts` | 凭证引用、URL 规范化、探测策略及类型 |
| 外部 `model-probe` | 模型列表/能力探测、models.dev 目录、来源分层与默认值 |

## 核心流程

1. **添加**:选择来源 → 端点/名称/密钥 → 获取目录或自动探测/手动输入 → 元数据转换 → 保存 provider → 刷新注册表 → 保存凭证。
2. **编辑与对账**:加载配置 → 探测模型及元数据 → 比较已存模型 → 三态选择新增、更新、保留或移除 → 写入配置并刷新。现有模型仅允许实测和目录数据覆盖,推测值主要用于新模型。
3. **删除与重命名**:先保存模型配置并刷新,再尽力清理/迁移凭证。
4. **存储**:Pi 的模型与凭证分别写入 `models.json` / `auth.json`;OMP 使用 YAML 或已有 JSON,凭证内联。保存时迁移 Pi 的旧内联 key;YAML 序列化会丢弃注释。

## 检查结果

| 检查 | 结果及边界 |
| --- | --- |
| 修改前 `npm run check` / `npm run build` / `npm pack --dry-run --json` | 均通过;build 仅输出无需构建 |
| `npm install --no-package-lock --ignore-scripts` | 成功;保留上游忽略 lockfile 的约定,未执行依赖安装脚本 |
| 本次依赖解析 | `model-probe@0.7.0`, `yaml@2.9.1`;npm 安装审计报告 0 个漏洞 |
| 修改后同一组检查、全部 13 个源文件语法检查、`git diff --check` | 均通过;打包预览包含新名称、评审文档及 LICENSE |
| `npm exec --yes --package=node@20.6.0 -- node --check index.ts` | 失败:`ERR_UNKNOWN_FILE_EXTENSION`;当前环境 Node.js 24.12.0 可通过 |
| 三态选择器隔离复现 | 输入 `a` 再发送 `0x7f`,搜索词未被删除,反而追加控制字符;单选及二态选择器正常 |
| 历史与许可证核对 | HEAD 与 upstream/main 均为导入基线,61 个提交,LICENSE 与上游逐字节一致 |

语法检查不包含类型、依赖解析或真实业务验证。两个可选宿主 peer dependency 未安装在本地包中;
本轮未运行真实 Pi / OMP 交互,未访问实际模型端点,未读取或修改用户的模型配置和凭证。
隔离复现使用内存中的 TUI 桩,没有向仓库加入测试或更改选择器代码。

## 现有问题与建议优先级

| 优先级 | 发现及依据 | 建议方向 |
| --- | --- | --- |
| P1 | `config.ts` 直接覆盖配置/凭证文件,没有原子替换、锁或版本冲突检测。中断可能损坏文件,多会话可能覆盖更新;凭证文件创建未显式指定 `0600` | 先设计安全存储边界:原子写入、并发检测、凭证权限、失败恢复 |
| P1 | `shared.ts` 的 `persistProvider` 先保存并刷新,`add.ts` 随后才保存 key;重命名也先刷新后移动 key。凭证失败时保留部分成功状态;新增流程忽略 `persistApiKey` 的失败返回值 | 合并配置与凭证的保存协调,完成后再刷新,明确部分失败状态;补故障场景验证 |
| P1 | `check` 仅语法检查且漏掉 `presets.ts`;声明 Node `>=20.6.0`,但该最低版本检查失败;无测试、类型检查或 CI,宿主 peer 版本为 `*` | 先确定支持的 Node / Pi / OMP 版本,补齐检查覆盖、关键流程测试和兼容性矩阵;评估 lockfile 策略 |
| P2 | `ui/select.ts` 的 `pickTriState` 将退格/ESC 字符写成普通字符串 `"007f"` / `"001b"`;常见退格编码已复现失效 | 修正输入编码判断,覆盖退格、取消、筛选后切换及确认 |
| P2 | `edit.ts` 的 `DIFFABLE_FIELDS` 不比较 `effortOptions` / `alwaysThinking`;`applyMetaChanges` 启用 reasoning 时直接使用 `xhigh`,没有复用新增时的精确档位转换 | 统一新增与更新的元数据映射,覆盖仅档位变化及禁止关闭思考的模型 |
| P2 | `api-key.ts` 的 shell key 解析使用无超时的 `execSync`;`edit.ts` 多个元数据网络调用在局部错误处理之外 | 为命令解析增加超时,明确网络失败/取消的处理,减少 UI 阻塞及未捕获异常 |
| P3 | `edit.ts` 集中多种流程,删除逻辑有重复;`ModelsConfig` / model 大量使用 `any`;内置 provider id 列表静态维护 | 在关键行为有验证后拆分编辑流程、收紧配置类型,明确宿主适配层 |

以上文件完整性、并发和刷新顺序结论来自静态代码审查,尚未在真实宿主中进行故障注入。
建议首先确定 **可靠性与检查基线** 的范围(P1),再处理交互与元数据一致性(P2),最后进行结构整理(P3)。
本轮未实施这些优化。
