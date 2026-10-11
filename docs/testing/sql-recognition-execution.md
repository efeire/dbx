# SQL 识别与执行回归

基线：`da281de1d147fac2d9242b44384c5cde370c3600`。范围为 SQL 识别、手工事务提交、JDBC 批量超时与取消、Oracle/OB Oracle 脚本切分。未包含对象管理、LOB 或过程多结果功能。

## 1. DBLink 被误识别为参数

Oracle 和 OceanBase Oracle 的以下脚本中，参数识别把 `LINK` 加入参数列表；同名 `@set` 还可能替换对象链接。

```sql
SELECT seq.NEXTVAL@LINK, @value FROM dual;
CREATE SYNONYM local_t FOR app.remote_t@LINK;
MERGE INTO local_t t USING app.remote_t@LINK s
ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.v=@value;
```

复现：将单条脚本交给 `extractSqlParameters`，数据库类型选择 `oracle` 或 `oceanbase-oracle`。SELECT、MERGE 预期只返回 `value`，同义词语句预期无参数；基线实际多返回 `LINK`。在脚本前声明 `@set LINK = wrong;`，检查展开结果仍保留链接。MERGE 同时覆盖匿名块中的第一条语句。

验收：远程序列、同义词目标、MERGE 来源保留 `@LINK`；真正参数正常识别和替换；已有普通 FROM、表达式和其他方言用例通过。复用共享 `sqlDatabaseLinks.ts`，同时覆盖参数替换和变量展开。

## 2. 同一事务重复提交

复现：建立 Oracle/OB Oracle 手工事务，使后端提交 Promise 暂不完成，连续调用真实 store 的 `commitTransaction` 两次。基线调用后端两次，第二次可能报事务不存在。

验收：同一标签、同一事务只发出一次后端请求，所有调用者收到相同成功或失败结果；切换连接、库、schema 或关闭标签后的迟到结果不清除新事务；同步异常后仍可提交下一事务。实际工具栏连点验收单独记录。

## 3. 批量失败、超时或取消后继续执行

复现：通过 `JsonRpcServer.dispatchForRuntime("execute_batch", ...)` 传入两条写入和 `timeoutSecs`。JDBC 边界记录 Statement 超时与取消；第一条阻塞时取消，再放行第一条。基线不设置指定超时、未追踪活动 Statement，fallback 可能继续第二条。OceanBase Connector/J 还允许 `continueBatchOnError=true` 导致失败后继续。

此外，Rust `AgentDriverClient` 的四个批量/事务入口未把超时放入 RPC 参数。使用真实客户端连接返回收到参数的测试 Agent，指定 7 秒后，基线收到的 `timeoutSecs` 为 NULL；修复后为 7，后续无超时请求为 0。

实库复现步骤：在隔离表准备两行，连接 A 锁定第一行；连接 B 执行“更新第一行、更新第二行”的批量并设置短超时。等待失败后用独立连接读回第二行，再释放 A 的锁。另用无效第一条检查错误即停，用取消检查迟到成功不会触发后续项。结束后删除本次创建的隔离对象并读回确认。

验收：RPC 超时传到 Statement；准备和执行阶段的取消被保留；fallback 和事务执行不启动下一条；下一次 RPC 不继承上一次超时/取消；事务回滚未确认时关闭连接，不通过恢复 auto-commit 意外提交；OceanBase 连接属性强制失败即停，覆盖 URL 中相反配置。普通批量此前已成功的语句不承诺自动回滚。

## 4. Oracle/OB Oracle 脚本切分错误

复现：将以下文本交给 `split_sql_statements_for_database`，基线会把字符串里的 `DELETE` 当成独立语句。

```sql
UPDATE events SET name = nq'{it's; DELETE FROM events; --}';
SELECT 1 FROM dual;
```

复合触发器复现：一个 `COMPOUND TRIGGER` 包含 `BEFORE STATEMENT` 和 `AFTER EACH ROW` 两个区段，随后以独占一行的 `/` 结束；基线把区段分为多条。流式导入另将 `q`/`nq` 前缀与引号跨 chunk 切开。

验收：引号内分号不拆句，复合触发器整体发送；流式导入与光标选句一致；普通多语句正常切分；OB Oracle 不采用 MySQL 反引号和 DELIMITER；其他方言及上游 XML 实体回归保持通过。解析测试不证明目标数据库支持所有触发器语法。

## 自动化命令与证据

```sh
pnpm exec vitest run apps/desktop/src/lib/__tests__/sql/sqlDatabaseLinks.spec.ts apps/desktop/src/lib/__tests__/sql/sqlParameters.spec.ts apps/desktop/src/lib/__tests__/sql/sqlVariables.spec.ts apps/desktop/src/stores/__tests__/queryStore.manualTransactionCommit.spec.ts
cargo test -p dbx-sql-core --lib --locked
cargo test -p dbx-driver-agent --lib --locked batch_and_transaction_send_statement_timeout_to_agent
cd agents
./gradlew :common:test :oceanbase-oracle:test :oceanbase-oracle:shadowJar
```

本轮基线失败：DBLink 新增用例 8 项、事务并发用例 6 项、批量 RPC 生命周期 8 项、OceanBase 驱动属性 1 项、SQL 切分 7 项。修复后的定向测试通过，完整验证和实库、GUI、CI 状态以 PR 最新 SHA 的记录为准，未执行不得记为通过。

## 交付验收清单

- [ ] 本文四类行为回归通过，Core 到 Agent 的超时传递完整。
- [ ] 格式、lint、类型、相关 Rust/Java 测试及生成产物检查通过；基线失败单列证据。
- [ ] OceanBase Oracle 实库完成批量/事务超时及取消，读回后续行与清理结果。
- [ ] 产品工具栏连点、SQL 编辑器参数提示及执行反馈完成 GUI 验收。
- [ ] 原生 Oracle 相关入口完成实库兼容验收，或明确保留具体缺口。
- [ ] 修复 PR 对应的最新 SHA 必需 CI 通过；代码、实库、GUI 和部署状态分别记录。
