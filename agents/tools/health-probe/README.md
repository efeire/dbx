# 查询前健康探测验证（V06b / #11472）

此目录是独立验证工具，不进入生产 Agent 包，不提供测试专用生产 API。源码与行为用例已编写，尚未编译或执行。未确认重复探测缺陷，生产健康检查逻辑保持原状。

## 采样口径

`HealthProbe.java` 在独立 JVM 中实例化当前 `OceanBaseOracleAgent`，调用生产 `JsonRpcServer.dispatchForRuntime`；可选生产连接池。仅 JDBC 连接与 Statement 用透明代理计数，不替换数据库执行，也不记录 SQL、绑定值、连接串、用户名、密码或原始错误。

| 字段 | 口径 |
| --- | --- |
| `dispatch_ms` | 进程内 RPC 分派至返回，包括健康检查、连接获取/重连、执行和结果读取；不含 IPC、网络到客户端或渲染 |
| `jdbc_isValid_calls/ms` | JDBC `Connection.isValid` 调用次数/耗时；不等于网络往返数，也不等于 SQL 请求数 |
| `jdbc_statement_execute_calls/ms` | 经代理 Statement 的执行调用，包括 Agent 自身会话设置；不包含驱动内部或 unwrap 后绕过代理的命令 |
| `physical_connect_calls` | 物理驱动连接调用次数，包含失败尝试 |
| `agent_stages_ms` | 生产 QueryTiming 各阶段；阶段可能包含上述 JDBC 耗时，不相加成另一个总时间 |
| `reported_execution_ms` | 既有结果执行口径，保留原值，不命名为数据库纯执行时间 |
| `jdbc_cancel_calls` | 实际送达 Statement 的取消次数；取消竞态中查询已完成不算取消通过 |

冷查询表示显式 connect 后的首个查询；热查询紧接前一个查询；空闲查询等待 5.1 秒跨过非池化验证窗口。失效场景仅关闭本工具创建的物理连接，分别记录窗口内、窗口后的行为；失败不隐藏。重连是显式 disconnect/connect。取消使用固定只读查询竞态，不制造业务长查询或锁。全部查询是固定 `SELECT 1 FROM DUAL`。

## 后续统一执行

必须使用专用测试连接，并在单独 JVM 中运行；工具会替换该进程的 DriverManager 注册以观测真实驱动。不要把 main 加载进桌面或共享 Agent 进程。

在已授权的统一验收阶段，先构建当前固定 SHA 的 OB Agent；将产物绝对路径设为 `$probeAgentJar`，输出目录设为 `$probeClasses`，再执行：

```powershell
javac -cp $probeAgentJar -d $probeClasses agents/tools/health-probe/HealthProbe.java
java -cp "$probeClasses;$probeAgentJar" com.dbx.agent.HealthProbe pooled 20
```

通过当前进程环境设置以下内容，凭据不要放命令参数、脚本正文或日志：

- `DBX_HEALTH_DEDICATED=1`：明确使用可关闭重连的独立测试连接。
- `DBX_HEALTH_CONNECT_JSON`：与现有 connect 协议相同的连接参数；只在进程内解析。
- `DBX_HEALTH_OUTPUT`：一个不存在的 JSONL 文件绝对路径；使用 CREATE_NEW，避免覆盖旧证据。

另用新的输出文件运行 `direct 20`。每次约有两段 5.1 秒等待/样本，勿将不同模式混在同一分布。保存 Git SHA、Agent JAR SHA256、采样日期、版本记录，以及经过脱敏的测试环境/网络条件。初始版本元数据读取在查询测量外单独记录，不能用此工具的 connect 时间作为无探针开销的连接基准。

```powershell
python agents/tools/health-probe/summarize.py <JSONL绝对路径>
```

汇总器按场景和 outcome 分开报告 n/min/p50/p95/max，不混合失败延迟。原始数值样本保留，不能仅凭 p50 或单次差异确认性能问题。

新增常规回归 `:common:test --tests com.dbx.agent.QueryHealthValidationTest` 使用实际 RPC 分派、Agent 和 H2，只在 JDBC 边界注入失效/取消；汇总器回归为 `python -m unittest discover -s agents/tools/health-probe -p test_summarize.py`。上述命令本阶段均未运行。

## 尚待实证

JDBC 计数不能证明真实网络请求数。统一验收需补充目标 JDBC 版本的驱动协议证据或隔离连接的包级计数，区分 ping、SQL 与 TLS 下不可见信息；只留命令类别/数量/时长，不保存业务载荷。不能为普通查询新增 SQL_AUDIT 补查来填这个空缺。

原生 Oracle 走 Rust/OCI，应使用其实际生产入口独立测量；本 Java 工具不代表原生 Oracle。客户端 IPC/传输/渲染也需真实桌面证据。实际网络中断、验证阻塞与成功取消仍需专用环境验收；快速查询的取消竞态可能只能得到“查询已完成”。当前没有实库样本、性能结论、修复前后对比或 GUI 通过结论。

若后续确认重复探测或阻塞缺陷，再为实际调用链写失败回归并做最小修复；保留失效检测和错误分类，经独立 Standards/Spec、固定 SHA CI 后交付。无缺陷时记录保留现状的证据，不为性能猜测修改生产行为。
