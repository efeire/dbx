# O08 触发器 owner 身份补齐

本检查点基于 `12411c477daed6c787a0ca1bb6c3445650c7653b`，仅完成代码与行为用例编写，尚未通过行为测试或数据库验收。

## 字段契约

- TypeScript：`TriggerInfo.owner?: string | null`。
- Rust 元数据 DTO 和结构编辑原始 DTO：`Option<String>`，缺字段或 `null` 读取为 `None`。
- Java：可空 `owner`；保留三参数构造器，默认 `null`。
- Oracle-go：`*string`，JSON 字段 `owner` 可省略。
- 合法来源为当前查询结果的 `ALL_TRIGGERS.OWNER`。保留精确大小写和标识符字符；不得从表 schema 推断触发器 owner。
- 非 Oracle 引擎原有构造点填 `None`，不新增 owner 推断。

## 行为

Oracle-go 和 OB Java 的表触发器列表按 `TABLE_OWNER + TABLE_NAME` 定位，返回真实触发器 owner，按 `OWNER + TRIGGER_NAME` 排序。Oracle-go 的 `ALL_SOURCE` 连接和多行源码分组均采用触发器 owner 与名称。OB 的 Rust 兼容路径同时返回字典 owner。

表信息面板和对象浏览器使用 owner/name 身份作为列表键，并显示 `owner.name`。结构编辑草稿保留 `original.owner`，用两字段身份产生独立 id。缺失 owner 的旧报文保持未知，不与明确 owner 合并。

共享结构 SQL 计划的 Oracle/OB DROP 使用 `original.owner` 限定对象；缺 owner 时产生警告且不生成 DROP。创建表计划不会 DROP 或重建带 `original` 的已有 Oracle 触发器。现有 Oracle 克隆入口通过独立新名称和显式目标表创建新触发器、清除 original，仍不删除源触发器。

结构比较按 owner/name 匹配，不合并跨 owner 同名对象。通用 Oracle/OB 表重建路径无法保留完整触发器声明与 owner 映射，因此标记触发器回滚不完整，要求人工提供完整定义，不生成猜测身份的 CREATE TRIGGER。其他引擎维持原有计划。

## 集成边界

本检查点不修改 `TableStructureEditor.vue`、E08 对话框或 `current-status.md`。E08 编辑入口由协调会话接入 owner，表 schema 与触发器 owner 分开传递。该入口最终依赖协调会话的 E08 检查点及本检查点；本记录不代表整体依赖已冻结。

V02 分支已补 `getObjectSource(TRIGGER)` 的完整源定义与状态，本检查点不重复改动该分支的取源实现。

## 用例与检查边界

已编写 Java、Go、Rust、TS 用例，覆盖跨 owner 同名、源行分组、精确标识符、缺失/null owner、真实 owner DROP、未知 owner 阻断、克隆保护和比较/回滚保护。

仅执行 Rust 格式/语法解析、6 个 TS/Vue script 语法解析和 `git diff --check`。未运行行为测试、typecheck、完整构建、双审、GUI、真实数据库验收、CI 或推送；Java/Go 用例尚未编译执行。
