# Pipeline · 自定义工具与组合执行平台

> 用户要求：后续仅本地开发、预览与测试；未经明确指令，不上传源码或发布部署。

外部 Agent 负责理解目标、定义或选择 Function、提交 Task 并验收最终结果。平台后台接管 Task 内的 Function 顺序、共享 Context、Loop、续跑与运行记录，通过 HTTP API 与 MCP 提供访问。Function 可以独立调用，也可以加入 Task 组成可复用流程；Task 支持手动、固定间隔和指定时间执行。定义、调度状态、运行快照、上下文、结构化资源、步骤与日志保存在本地 Cloudflare D1。

MCP 是平台对 Agent 的访问协议。当前提供自定义函数管理和组合执行能力，不内置 Agent 主控，也不自动发现或聚合任意外部 MCP Server。

## 本地启动

需要 Node.js 22.13 或更新版本。

```sh
npm run install:ci
npm run build
```

首次启动前，将 `drizzle/` 下尚未应用的 SQL 迁移按文件顺序执行到本地 D1。已应用的迁移不要重复执行。后续新增迁移时按文件顺序执行。`0003_function_only.sql` 是一次性结构与数据迁移，保留已有定义和运行记录；应用后运行时只使用 Function 数据模型。

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .pipeline/state --file drizzle/0000_redundant_onslaught.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .pipeline/state --file drizzle/0001_illegal_ben_urich.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .pipeline/state --file drizzle/0002_windy_plazm.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .pipeline/state --file drizzle/0003_function_only.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .pipeline/state --file drizzle/0004_run_completions.sql
npm run dev
```

打开终端打印的 Local URL。开发服务默认使用端口 5173，可通过 `npm run dev -- --port 5198` 指定端口。便携开发模式下，可访问 `/signin-with-chatgpt?return_to=/` 获得本地测试身份。本地数据库与线上数据库相互独立。

`npm run dev` 和构建后的 `npm run start` 会随 Web 服务启动本地调度进程，默认每 5 秒检查一次。关闭浏览器后，服务进程仍可按规则执行；关闭终端、停止服务或电脑休眠期间不会触发。调度器只向本机 HTTP 地址请求。若只需手动执行，可设置 `PIPELINE_DISABLE_SCHEDULER=1`；单独运行调度器可使用 `npm run scheduler -- http://127.0.0.1:5198`，端口必须对应正在运行的本地服务。`npm run start` 默认使用端口 8787，也支持 `--port`。

Task 由外部 Agent 通过 `task_create` MCP 工具或 `POST /api/tasks` 创建。Function 和 Task 的创建、修改、提交与结果验收由外部 Agent 通过 HTTP API/MCP 完成；已提交 Task 的执行过程由平台独立完成。管理后台用于查看定义、状态、上下文、资源和日志，唯一的数据写操作是删除 Task。

修改数据库结构时，先编辑 `db/schema.ts`，再执行 `npm run db:generate`，检查新 SQL 后纳入源码。不要改写已应用的迁移。

## 本地工作空间与存储位置

默认工作空间是项目根目录下的 `.pipeline/`。启动前可通过 `PIPELINE_WORKSPACE_ROOT` 指定绝对路径或相对项目根目录的路径；平台、调度进程和 Function Runner 应使用同一设置。执行 `npm run workspace` 可查看已解析的实际路径，也可由 Agent 调用 `workspace_get` 或 `GET /api/workspace` 只读查询。

```text
.pipeline/
├── state/v3/d1/          本地 D1：Function 定义与内联代码、Task、Run、Context 和结构化资源
├── functions/           Function 模块源码的默认位置
│   └── modules.json     模块名称到源码文件及导出函数的注册表
└── runs/
    └── <runId>/
        ├── work/        本次执行的工作文件
        └── artifacts/   本次执行代码写入的产物
```

`config.code` 的代码正文保存在 Function 定义的 D1 数据中；`config.entry` 则引用模块注册表中的名称，实际代码保存在模块文件。同一 Run 的全部 Function 共用它的运行目录和 Context；不同 Run 的目录相互分开。Runner 会准备 `work` 和 `artifacts` 目录并向执行代码提供 `workspace` 对象，其中 `workspaceId`、`runId` 标识归属，`rootPath` 是当前 Run 目录，`workPath` 与 `artifactsPath` 是可用于工作文件和产物的实际路径。目录是执行位置约定，不代表对受信代码建立了安全沙箱。

自定义位置示例：

```sh
export PIPELINE_WORKSPACE_ROOT="/absolute/path/to/pipeline-workspace"
npm run workspace
npm run dev -- --port 5198
# 另一个采用相同环境变量设置的终端
npm run function-runner
```

上面的数据库迁移命令使用默认 `.pipeline/state`；自定义根目录时，将 `--persist-to` 替换为 `npm run workspace` 输出的 `statePath`，已有数据也应放在同一位置。`GET /api/workspace` 和 `Bootstrap.workspace` 返回实际 `rootPath`、`statePath`、`functionsPath`、`runsPath`、`registryPath` 与 `configured` 状态，`definitionStorage` 固定为 `local-d1`。

目前没有平台通用文件读取、写入或上传接口。`resource.add` 和 Runner 返回的 `resources` 仍是 D1 中的结构化 JSON；资源名为 `report.md` 不会自动生成文件。需要文件时由执行代码明确写入当前 Run 的产物目录，Agent 仍负责验收结果。

## 本地管理界面

任务、运行记录、函数库和 API 文档采用紧凑列表。界面只读展示 Function 定义、Task 的函数组合与执行规则，以及 Run 的 Context、资源、步骤和日志；可复制定义和结果供 Agent 使用。Task 列表显示下次执行与最近执行，运行记录标记 Agent 发起的调用或定时触发。界面不提供新建、编辑、启停、执行、取消或续跑入口；保留删除 Task 的确认操作，历史 Run 不受删除影响。弹窗支持 Escape、Tab 焦点循环和关闭后恢复焦点。

## 执行模型

| 对象 | 含义 |
| --- | --- |
| Task | 由 Agent 创建的可复用版本化任务定义：状态、Function 顺序、初始 Context、Loop 条件和执行规则。 |
| Function | 独立保存的版本化执行单元，可在创建 Task 前先定义。 |
| Task 内的 Function 快照 | 从库复制或手工创建的执行快照，支持启停、重试次数、失败停止或继续策略。 |
| Function Call | 一次独立函数调用，对应 kind=function 的持久化 Run，记录函数版本、输入和结果。 |
| Run | 一次独立执行，承载共享 Context；Task 运行保存组合快照，独立调用保存函数快照。 |
| Context | 同一 Run 共享的 JSON 对象，后续 Function 与 Loop 能读取前面 Function 成功保存的数据；不同 Run 从各自的初始 Context 开始。 |
| Resource | Function 生成的结构化资源，附带 Function、迭代轮次和生成时间。 |
| Loop | 每轮按顺序执行启用的 Function，受最大轮数与上下文停止条件限制。 |

Task 提交接口只持久化排队记录并返回票据，不在请求中执行 Function。平台后台约每 5 秒消费队列，每个批次约 18 秒，达到预算时在 Function 边界保存检查点并自动续跑；手动提交和定时触发的 Task 都无需 Agent 调用 resume。网络 Function 仍受单次请求超时约束。同一 Task 同时最多保留一个 queued、running 或 paused Run，期间不会创建重叠运行。独立 Function 调用仍在请求中执行，调试接口可显式读取或续跑 Run。

暂停 Task 会停止新的定时触发与定时 Run 的自动续执行，当前执行批次仍可能继续到下一个检查点。Agent 已手动提交的后台 Run 按提交时的快照继续，即使后来修改、暂停或删除 Task；需要终止本次执行时显式取消 Run。取消 Run 会将其设为终态，调度器不会续执行该 Run；间隔规则的后续触发仍保留。停止与取消不会撤销已发送到外部系统的操作。远程操作使用 `runId:iteration:fn.id` 作为幂等标识；如果执行器中断并留下结果未知的远程标记，续执行会安全失败，不会再次发送该请求。

## 执行规则与时间

| 规则 | JSON | 行为 |
| --- | --- | --- |
| 手动 | `{ "type": "manual" }` | 默认规则，由 Agent 通过 MCP 或 API 发起时创建 Run。 |
| 固定间隔 | `{ "type": "interval", "every": 5, "unit": "minutes" }` | 启用后等待一个完整间隔，再周期执行；单位为 `minutes`、`hours` 或 `days`，`every` 为 1–365 的整数。 |
| 指定时间 | `{ "type": "once", "at": "2030-01-01T09:00:00+08:00" }` | 在指定时间或其后的首个可执行检查中启动一次；完成触发后不重复。新增或更改时间必须在未来。 |

界面固定使用北京时间（Asia/Shanghai，UTC+8）输入和展示时间，API 的 `at` 必须带 `Z` 或明确时区偏移，服务端统一保存为 UTC ISO 时间。`days` 表示固定的 24 小时，不是某个时区的日历日；当前不提供 cron 或每日固定钟点规则。调度基于服务时钟，每 5 秒检查一次；正在执行的批次、服务负载或机器休眠可能增加延迟，因此不保证准点到秒。

只对状态为 `active` 的 Task 生效。保存名称、Function、Context 等内容且执行规则相同，会保留下次触发时间；修改规则会重排。暂停或转为草稿会清除下一次触发，间隔任务重新启用后从恢复时刻等待一个完整间隔。一次性任务在已触发后即标为完成，普通保存或重新启用不会重复执行，需设置新的未来时间。

调度状态保存在数据库，服务重启后继续读取。停机期间错过的间隔合并为一次执行，然后从当前检查时刻重排下次时间；不会逐条补跑积压。停机时到期的一次性任务在恢复后执行一次。同一 Task 尚有排队、运行中或暂停的 Run 时，到期触发会等待；并发检查通过持久化抢占与唯一触发键避免创建重复 Run。后台调度状态依据最近 60 秒的心跳显示，停止调度器后可能短暂仍显示在线。

每次 Run 都从 Task 的 `initialContext` 加上本次调用传入的 Context 开始，定时运行不继承上次 Run 的结果。一个 Run 内，`context.set` 写入顶层字段，`context.merge` 递归合并对象；后续 Function 可用 `{{context.nested.foo}}` 读取最新字段，或用 `{{context}}` 读取整个共享对象。成功结果才会提交，失败尝试的输入变更不会泄漏到重试或后续 Function。资源也只归属生成它的 Run。

## 独立函数库与复用

可以只定义 Function，无需创建 Task。Agent 可通过 Function 管理 API/MCP 注册、修改和删除定义；后台「函数库」只读展示。保存只记录定义，不执行代码，也不创建 Run 或定时计划。选择执行器后，`code.remote` 通过 Runner 地址和代码正文（或已注册模块标识）关联实际实现，`agent.http` 通过地址和 prompt 关联 Agent，内置执行器则使用执行配置。

Agent 可从函数库复制一个或多个 Function 组成 Task，并通过 `task_update` 或更新接口调整函数组合。选入会生成新的 Function ID，保存完整配置副本，并以 `source: { "id": "库定义ID", "version": 1 }` 记录来源。Task 不会在运行时动态读取库的最新定义：库中的 Function 更新或删除后，已有 Task 和 Run 都保持原来的快照；需要使用新版本时，由 Agent 在 Task 中替换为新复制的 Function 快照。

同一个库定义可以加入多个 Task，也可以重复加入同一 Task。每个实例有独立 ID 和配置；执行时依然按所在 Task 的顺序共享当前 Run 的 Context。Function 本身没有调度规则；可通过独立调用执行一次，需要按规则执行组合时再加入 Task。

HTTP 与 MCP 都支持同一流程。例如先创建一个独立定义：

```sh
curl http://127.0.0.1:5198/api/functions \
  -X POST -H 'Content-Type: application/json' \
  --data '{"name":"准备输入","type":"code","handler":"context.set","config":{"values":{"ready":true}}}'

curl http://127.0.0.1:5198/api/functions/FUNCTION_ID/instantiate \
  -X POST -H 'Content-Type: application/json' --data '{}'
```

将第二个接口返回的 Function 对象放入 `Task.functions` 后保存任务。创建接口返回库定义的 `id`、`version` 与时间；更新时携带当前 `version`，旧版本返回 409。

## Agent 创建组合任务

Agent 通过 MCP `task_create` 或 HTTP `POST /api/tasks` 提交一个 Task。`functions` 是按执行顺序排列的 Function 快照数组，可以组合内置函数、代码 Runner 或 Agent 服务。例如：

```json
{
  "name": "共享 Context 报告",
  "status": "active",
  "initialContext": { "source": "agent" },
  "loop": { "maxIterations": 1 },
  "functions": [
    { "id": "prepare", "name": "准备数据", "type": "code", "handler": "context.set", "config": { "values": { "customer": { "name": "Pipeline" } } } },
    { "id": "summarize", "name": "读取前一步数据", "type": "code", "handler": "context.merge", "config": { "values": { "summary": "Hello, {{context.customer.name}}" } } },
    { "id": "save", "name": "生成结构化资源", "type": "code", "handler": "resource.add", "config": { "name": "report.json", "type": "application/json", "value": { "summary": "{{context.summary}}", "snapshot": "{{context}}" } } }
  ]
}
```

Agent 可调用 `task_execute({ taskId })` 等待最终结果，或用 `run_start({ taskId })` / `POST /api/tasks/{id}/run` 只提交任务。后台执行时，第二个 Function 读取第一个写入的 `customer`，第三个读取 `summary` 并保存资源。同一次 Run 的全部 Function 和 Loop 轮次共享这份 Context；新 Run 独立初始化。Agent 无需感知或调度中间 Function，最终按输出与资源验收；步骤和日志仅在需要调试时主动查询。

## Task 后台托管与最终结果

推荐使用 MCP `task_execute({ taskId, context?, recipient?, waitSeconds? })`：平台提交 Task 后最多等待 25 秒，成功、失败或取消时只返回最终结果，不返回 Function 步骤、日志或任务快照。HTTP 对应 `POST /api/tasks/{id}/execute`，已完成返回 200 和结果；等待超时返回 202 票据，后台仍会继续，关闭请求不会取消任务。

需要立即返回时，用 `run_start` 或 `POST /api/tasks/{id}/run`，响应是 HTTP 202：

```json
{ "runId": "RUN_ID", "taskId": "TASK_ID", "status": "queued", "resultUrl": "/api/runs/RUN_ID/result" }
```

之后用 `run_wait({ runId, waitSeconds: 25 })` 等最终结果，或 `run_result({ runId })` 立即查询。HTTP 为 `GET /api/runs/{id}/result?waitSeconds=25`；等待只是读取状态，不会执行或续跑 Function。未完成响应只含票据与 `ready: false`，完成后响应只含 `status`、`output`、`resources`、时间与接收者等最终字段。Agent 应检查终态 `status`；MCP 将 failed/cancelled 结果标为 `isError: true`，HTTP 最终结果本身仍是 200。

创建 Task 时可约定最终输出和接收者：

```json
{ "result": { "path": "report", "recipient": "report-agent" } }
```

`path` 指向最终 Context 的一个字段，只将该字段作为 `output` 返回；未配置时返回最终完整 Context。约定了路径但任务结束时未生成该字段，Run 会明确失败。单次提交可传 `recipient` 覆盖 Task 配置，未指定时默认为 `default`。recipient 用于本地结果归类，不是独立身份认证或权限边界。

平台将每个后台 Run 的终态结果持久化到收件箱，以 Run ID 去重；排队、执行中和批次暂停不会产生完成通知。Agent 可在恢复后读取 `completions_list({ recipient: "report-agent" })`，收到后调用 `completion_ack({ runId, recipient: "report-agent" })`。HTTP 对应 `GET /api/completions?recipient=report-agent` 与 `POST /api/completions/{runId}/ack`。确认幂等，确认后不再出现在未读收件箱，原始 Run 和最终结果仍保留；中断的收件箱写入会由后台补齐，不会重跑已完成 Function。

普通 MCP 请求不能主动唤醒一个离线 Agent。当前提供有界等待与持久化结果收件箱，客户端可以等待或消费收件箱；没有自动推送、Webhook 或消息通知。Task 执行本身不依赖 Agent 在线，仍需本地平台服务持续运行。固定间隔、指定时间、Loop 最大轮数、Context 停止条件和失败处理策略继续生效。

## 独立调用

Agent 可直接调用一个已启用的 Function：

```sh
curl http://127.0.0.1:5198/api/functions/FUNCTION_ID/call \
  -X POST -H 'Content-Type: application/json' \
  --data '{"context":{"count":3}}'
```

返回 HTTP 201 和完整 Run，`kind` 为 `function`，包含 `functionId`、`functionVersion`、Context、资源和步骤。此操作不创建 Task 定义。业务执行失败时仍保存 Run，Agent 应检查 `status` 和 `error`，不能仅凭 HTTP 201 判定成功；MCP `function_call` 会将失败 Run 标为 `isError: true`，并保留完整运行结果。每次调用独立初始化 Context，不自动继承之前调用的状态；Agent 需要显式传递上一轮结果。已禁用函数返回 409。

接口和数据仅使用 Function 模型：`Task.functions`、`Bootstrap.functions`、`Run.functionIndex`、`RunStep.functionId/functionName` 和 `Resource.functionId`。Runner 使用 `/functions/code`、`fn` 请求字段、`FUNCTION_RUNNER_*` 环境变量和 `npm run function-runner`。

这些调用的 `resources` 仍是结构化 JSON；Runner 提供本次 Run 的实际目录，但平台通用文件读写接口和产物验收状态尚未实现。平台不会替 Agent 评估业务结果。

## Function 接口

Function 定义的基础字段为：

```json
{
  "id": "fn_prepare",
  "name": "准备上下文",
  "type": "code",
  "handler": "context.set",
  "enabled": true,
  "config": { "values": { "project": "demo" } },
  "retries": 0,
  "onError": "stop"
}
```

内置 `context.set`、`context.merge`、`counter.increment`、`resource.add` 在服务器端实际执行。内置代码行为是固定实现，便于直接运行与审查；任意 JavaScript 源码通过 `code.remote` 交给独立 Runner 执行，Web Worker 内不使用 `eval`。

```json
{
  "id": "fn_count",
  "name": "累计处理量",
  "type": "code",
  "handler": "counter.increment",
  "enabled": true,
  "config": { "key": "processed", "amount": 1 },
  "retries": 0,
  "onError": "stop"
}
```

`resource.add` 使用 `config.name`、`config.type`、`config.value` 定义资源；资源始终附在当前 Run 上。Context 与 Resource 只接受 JSON 数据，不保存连接句柄、进程或文件描述符。

### 远程代码与 Agent

`code.remote` 与 `agent.http` 向 `config.endpoint` 发起 POST，使用相同协议。默认要求公开域名的 HTTPS 地址；本地开发可由服务端 `PIPELINE_LOCAL_RUNNER_ORIGIN` 精确允许一个本机 HTTP origin，例如 `http://127.0.0.1:8789`，不接受任意内网地址。`secretEnv` 是以 `PIPELINE_` 开头的服务端环境变量名称，例如 `PIPELINE_RUNNER_TOKEN`；本机密钥保存在被 Git 忽略的 `.dev.vars`，不写入 Function JSON、浏览器或源码包。远程 Function 每次仅发送一次，不自动重试；内置 Function 按定义中的 `retries` 执行重试。

```json
{
  "id": "fn_review",
  "name": "Agent 审阅",
  "type": "agent",
  "handler": "agent.http",
  "enabled": true,
  "config": {
    "endpoint": "https://your-agent.example.com/functions/review",
    "secretEnv": "PIPELINE_AGENT_GATEWAY_TOKEN",
    "prompt": "根据 context.items 给出审阅结论，并将结果写入 context.review。"
  },
  "retries": 0,
  "onError": "stop"
}
```

请求体包含执行标识、Function 定义及共享状态：

```json
{
  "runId": "run_...",
  "iteration": 1,
  "fn": { "id": "fn_review", "type": "agent", "handler": "agent.http", "config": {} },
  "context": { "items": ["first", "second"] },
  "resources": []
}
```

如果配置 `secretEnv`，服务器添加 `Authorization: Bearer <secret>`，并发送 `Idempotency-Key: <runId>:<iteration>:<functionId>`。远程服务应返回 HTTP 2xx 和不超过 64KB 的 JSON，支持以下字段：

```json
{
  "context": { "review": { "approved": true, "summary": "审阅完成" } },
  "resources": [
    { "name": "审阅报告", "type": "application/json", "value": { "approved": true } }
  ],
  "stop": false
}
```

Agent endpoint 是遵循上述协议的网关。若已有模型服务使用不同协议，需要在网关中进行转换；不能把任意模型 API 地址直接当成同协议 Function。未配置 endpoint 的 Agent 草稿执行时会明确报错，不会生成模拟 Agent 成功结果。

`examples/remote-function-server.mjs` 提供一个无需额外依赖的受信 JavaScript Runner，默认只监听本机 `127.0.0.1:8789`。本地使用步骤：

1. 复制 `examples/local-runner.vars.example` 为 `.dev.vars`，将 `PIPELINE_RUNNER_TOKEN` 改为至少 16 字符的本机密钥。该文件同时供平台和 Runner 读取，不要纳入源码包。
2. 启动 Runner，再在另一个终端启动或重启平台；全程只使用本机地址：

```sh
npm run function-runner
# 另一个终端
npm run dev -- --port 5198
```

3. Agent 通过 `function_create` 或 `POST /api/functions` 注册 `code.remote`，将 `config.endpoint` 设为 `http://127.0.0.1:8789/functions/code`、`config.secretEnv` 设为 `PIPELINE_RUNNER_TOKEN`，并选择以下一种代码关联方式。后台函数库可查看保存后的配置。

**内联代码**：`config.code` 是 JavaScript 异步函数体，可读取 `context`、`resources`、`fn`、`iteration`、`runId`，返回上述响应对象。例如：

```js
const total = Number(context.total || 0) + 1;
return {
  context: { total },
  resources: [{ name: `第 ${iteration} 轮结果`, type: "application/json", value: { total } }]
};
```

**注册模块**：`config.entry` 指向 Runner 预先注册的名称，不能填写任意文件路径。示例 Function 配置：

```json
{
  "endpoint": "http://127.0.0.1:8789/functions/code",
  "secretEnv": "PIPELINE_RUNNER_TOKEN",
  "entry": "normalize"
}
```

未设置 `FUNCTION_RUNNER_MODULES` 时，默认注册表位于工作空间的 `functions/modules.json`。示例中的 `FUNCTION_RUNNER_MODULES=examples/function-modules.json` 显式改用项目内的参考注册表，`workspace_get` 的 `registryPath` 会返回实际采用的文件。该表包含 `"normalize": "./functions/normalize.mjs#default"`：代码路径相对于注册表文件，`#default` 指定导出函数（省略则默认 default）。`examples/functions/normalize.mjs` 中的函数接收 `{ context, resources, fn, iteration, runId }`，输出 Context 补丁及资源。注册表改变后重启 Runner；每次执行在新 Worker 中加载模块，文件内修改会用于下一次执行。`code` 与 `entry` 只能选择一个。

Task 保存 `code` 或 `entry` 配置的版本快照；模块文件本身仍由 Runner 维护。需要固定文件版本时，注册不同名称，例如 `normalize-v1` 与 `normalize-v2`，并指向各自版本文件。

参考 Runner 仅允许受信管理员代码：`node:vm` 与 Worker 线程不是安全隔离沙箱。多租户或不受信代码需另行部署容器或专用沙箱服务，再按同一协议接入。

## AI 管理 API

平台管理和执行能力统一提供真实 API。外部 Agent 可独立注册、查询、修改、删除 Function，直接调用并读取结果，再自行决定下一步与验收。Agent 也可以复制 Function 快照组成 Task，交给平台按已确定的流程执行。

`/mcp` 提供只读工作空间查询 `workspace_get`，并暴露 JSON-RPC 工具：`functions_list`、`function_get`、`function_create`、`function_update`、`function_delete`、`function_instantiate`、`function_call`，并提供 `task_execute`、`run_start`、`run_result`、`run_wait`、`completions_list`、`completion_ack` 以及 Task 管理、Run 调试和调度状态工具。`function_instantiate` 返回可放入 `Task.functions` 的快照；`function_call` 接受 `{ functionId, context? }`，无需先建 Task。HTTP API 适合本地脚本和其他 Agent 客户端。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 后台数据、实际工作空间与当前身份 |
| GET | `/api/workspace` | 只读查询本地工作空间和存储路径 |
| GET / POST | `/api/functions` | 列出或独立创建 Function |
| GET / PATCH / DELETE | `/api/functions/{id}` | 读取、更新或删除 函数库定义 |
| POST | `/api/functions/{id}/instantiate` | 复制一份带来源版本的 Function 快照，不执行 |
| POST | `/api/functions/{id}/call` | 独立调用并保存 Run，无需先创建 Task |
| GET / POST | `/api/tasks` | 列出或创建 Task |
| GET / PATCH / DELETE | `/api/tasks/{id}` | 读取、更新或删除定义 |
| POST | `/api/tasks/{id}/run` | 只提交后台 Task，202 返回票据 |
| POST | `/api/tasks/{id}/execute` | 提交并最多等待 25 秒，只返回最终结果或票据 |
| GET | `/api/runs/{id}/result` | 读取或有界等待最终输出，不含中间步骤 |
| GET | `/api/completions` | 按 recipient 读取未确认最终结果 |
| POST | `/api/completions/{id}/ack` | 幂等确认已收到最终结果 |
| GET | `/api/runs` | 列出执行记录 |
| GET | `/api/runs/{id}` | 读取 Context、资源、日志与步骤 |
| POST | `/api/runs/{id}/cancel` | 请求取消 |
| POST | `/api/runs/{id}/resume` | 显式调试续跑；托管 Task 自动续跑 |
| POST | `/api/scheduler/tick` | 后台消费队列、自动续跑与检查到期任务，请求体为 `{}` |
| GET | `/api/openapi.json` | 获取 OpenAPI 合同 |

私有 Sites 的非浏览器调用使用平台提供的服务令牌，发送 `OAI-Sites-Authorization: Bearer <token>`。平台验证并消费此头，不会将令牌暴露给应用。它与 Function 网关的 `Authorization` 令牌是两个不同的凭据。请从 Sites 支持的服务访问路径获取令牌；应用不会生成或展示假的 API Key。

```sh
curl "$PIPELINE_BASE_URL/api/tasks" \
  -H "OAI-Sites-Authorization: Bearer $PIPELINE_SERVICE_TOKEN"

curl "$PIPELINE_BASE_URL/api/tasks/TASK_ID/run" \
  -X POST \
  -H "OAI-Sites-Authorization: Bearer $PIPELINE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"context":{"source":"ai"}}'
```

创建或更新 Task 时，可通过 `schedule` 设置上述执行规则；返回的 `scheduling` 包含 `nextRunAt`、`lastRunAt`、`lastRunId` 和 `completed`。`GET /api/bootstrap` 返回调度心跳状态；Run 的 `trigger` 为 `manual` 或 `schedule`，定时 Run 的 `scheduledFor` 表示该次计划时间。调度 API 不接受客户端指定时钟、批次预算或执行器。

更新 Task 可携带当前 `version` 做乐观并发检查。Run 使用启动时的定义版本，因此更新任务后重跑才会应用新定义。原始代码、prompt、Context、日志与资源都属于应用数据，请按实际业务需要控制内容与保留期限。

## 工程结构

```text
app/page.tsx             管理后台
app/api/                JSON API 与 OpenAPI
lib/contracts.ts        前后端共享模型
lib/server/             持久化与执行引擎
db/schema.ts            D1 / Drizzle 表结构
drizzle/                数据库迁移
examples/               远程 Function 服务示例
scripts/scheduler-runner.mjs 本地服务调度进程
tests/                  SQLite D1 行为测试与调度进程测试
.openai/hosting.json     Sites 身份及 DB 绑定
```

构建命令为 `npm run build`，构建后可通过 `npm run start` 在本地预览。当前工作仅限本地，不包含上传、push 或发布。

行为验证可执行：

```sh
node --test tests/*.test.mjs
```

引擎与调度测试使用内存 SQLite 适配 D1，执行实际迁移、存储 SQL 和 Function 引擎。覆盖多 Function 共享 Context 与跨 Run 隔离、失败继续与失败输入隔离、一次性与间隔规则、暂停与取消、停机迟到恢复、并发抢占、运行不重叠、自动续跑和未知远程结果重放保护。后台托管测试覆盖排队提交、自动多批续跑、最终输出投影、失败/取消终态、收件箱去重与确认、等待超时和客户端离开后继续执行；调度进程测试覆盖本地地址限制、端口解析及停止时取消请求。函数库测试覆盖独立定义、版本冲突、快照隔离、库更新/删除后 Task 与 Run 保持不变，以及 HTTP 和 MCP 的创建、读取、复制与删除。Runner 测试在临时本机端口验证内联代码、注册模块、鉴权、地址限制、执行超时和后续恢复。测试不连接线上数据库或外部 Runner。
