Cybros 采用**双镜像分层架构**进行容器化部署：Core Matrix 作为控制平面运行于 PostgreSQL 之上，Fenix 作为代理程序运行时运行于 SQLite 之上。两套镜像均基于多阶段构建，通过 Thruster 反向代理对外暴露 80 端口。本文档详述生产 Docker Compose 编排的结构、环境配置、服务依赖关系与调优参数，覆盖 Core Matrix 独立部署和 Core Matrix + Fenix 联合部署两种场景。

Sources: [Dockerfile](https://github.com/jasl/cybros.new/blob/main/core_matrix/Dockerfile#L1-L86), [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L1-L127), [Dockerfile](https://github.com/jasl/cybros.new/blob/main/agents/fenix/Dockerfile#L1-L113), [docker-compose.fenix.yml](https://github.com/jasl/cybros.new/blob/main/agents/fenix/docker-compose.fenix.yml#L1-L31)

## 架构总览

整个部署拓扑由以下核心服务构成。Core Matrix 的 compose 编排包含四个服务（数据库、迁移器、Web 应用、后台作业），Fenix 的 compose 编排包含两个服务（代理运行时、开发代理）。两者可独立运行，也可通过环境变量互联。

```mermaid
graph TB
    subgraph "Core Matrix Compose"
        direction TB
        DB["db<br/>pgvector/pgvector:pg18-trixie<br/>PostgreSQL 18 + pgvector"]
        MIG["migrator<br/>一次性迁移服务<br/>db:prepare"]
        APP["app<br/>Puma + Thruster<br/>端口 8080→80"]
        JOBS["jobs<br/>Solid Queue Worker<br/>后台任务处理"]
    end

    subgraph "Fenix Compose (可选)"
        direction TB
        FNX["fenix<br/>Puma + Thruster<br/>端口 3101→80"]
        PROXY["fenix-dev-proxy<br/>Caddy 反向代理<br/>端口 3310"]
    end

    DB --> MIG
    DB --> APP
    DB --> JOBS
    MIG -.->|service_completed_successfully| APP
    MIG -.->|service_completed_successfully| JOBS

    APP -.->|CORE_MATRIX_BASE_URL<br/>Machine Credential| FNX
    FNX -.->|FENIX_DEV_PROXY_ROUTES_FILE| PROXY

    classDef database fill:#2d5016,stroke:#4a8c1c,color:#fff
    classDef rails fill:#7c2d12,stroke:#c2410c,color:#fff
    classDef proxy fill:#1e3a5f,stroke:#3b82f6,color:#fff

    class DB database
    class MIG,APP,JOBS,FNX rails
    class PROXY proxy
```

上图中实线表示直接服务依赖，虚线表示跨编排的运行时连接。Core Matrix 的 `migrator` 必须在 `db` 健康且迁移成功后才允许 `app` 和 `jobs` 启动——这是通过 `service_completed_successfully` 条件实现的严格启动门控。

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L19-L123), [docker-compose.fenix.yml](https://github.com/jasl/cybros.new/blob/main/agents/fenix/docker-compose.fenix.yml#L1-L31)

## 镜像构建分析

### Core Matrix 镜像

Core Matrix 镜像采用经典的三阶段构建模式，基于 `ruby:4.0.2-slim`：

| 阶段 | 基础镜像 | 职责 | 关键产物 |
|------|---------|------|---------|
| `base` | `ruby:4.0.2-slim` | 运行时依赖安装 | jemalloc、libvips、postgresql-client |
| `build` | `base` | 编译 Gems、Node 模块、预编译资产 | vendor/bundle、node_modules、public/assets |
| 最终阶段 | `base` | 精简运行时 | 非 root 用户 (uid 1000)、仅复制编译产物 |

构建过程中 `SECRET_KEY_BASE_DUMMY=1` 用于绕过资产预编译对密钥的依赖，最终镜像不包含构建工具链和 node_modules，确保镜像体积最小化。容器以 `rails` 用户（uid/gid 1000）运行，入口点在启动 Rails server 前自动执行 `db:prepare` 进行数据库迁移。

Sources: [Dockerfile](https://github.com/jasl/cybros.new/blob/main/core_matrix/Dockerfile#L1-L86), [bin/docker-entrypoint](https://github.com/jasl/cybros.new/blob/main/core_matrix/bin/docker-entrypoint#L1-L9)

### Fenix 镜像

Fenix 镜像的构建更为复杂，采用**四阶段构建**且基于 `ubuntu:24.04` 而非 Ruby 官方镜像，因为 Fenix 运行时需要 Playwright、Caddy、Node.js、Python 等额外的系统依赖：

| 阶段 | 基础镜像 | 职责 |
|------|---------|------|
| `base` | `ubuntu:24.04` | 运行时工具链（通过 `bootstrap-runtime-deps.sh` 安装 Playwright 系统库、Node.js、Caddy、Python） |
| `ruby-runtime` | `base` | 从源码编译 Ruby 4.0.2 + Bundler（确保与 Ubuntu 24.04 的 OpenSSL ABI 兼容） |
| `build` | `base` + `ruby-runtime` | 安装 Gems、Playwright Chromium、应用代码 |
| 最终阶段 | `base` + `ruby-runtime` | 精简运行时，root 入口点负责路径初始化后降权至 uid 1000 |

Fenix 入口点的设计与 Core Matrix 有一个关键区别：它以 root 身份启动，执行 `/rails/storage` 和 `/rails/tmp` 目录的创建与权限设置后，通过 `setpriv` 降权至应用用户再执行实际命令。这确保了挂载卷在首次运行时具有正确的所有权。

Sources: [Dockerfile](https://github.com/jasl/cybros.new/blob/main/agents/fenix/Dockerfile#L1-L113), [bin/docker-entrypoint](https://github.com/jasl/cybros.new/blob/main/agents/fenix/bin/docker-entrypoint#L1-L32), [bootstrap-runtime-deps.sh](https://github.com/jasl/cybros.new/blob/main/agents/fenix/scripts/bootstrap-runtime-deps.sh#L1-L106)

## Core Matrix 编排详解

### 服务依赖与启动顺序

`compose.yaml.sample` 的 YAML 锚点 `&default-app` 定义了所有应用服务的共享配置，通过 `<<: *default-app` 合并到各服务中。启动顺序严格遵循以下依赖链：

```mermaid
sequenceDiagram
    participant User
    participant DB as db (PostgreSQL)
    participant MIG as migrator
    participant APP as app
    participant JOBS as jobs

    User->>DB: docker compose up
    activate DB
    Note over DB: healthcheck: pg_isready<br/>interval: 10s, retries: 5
    DB-->>DB: service_healthy
    deactivate DB

    User->>MIG: depends_on db (healthy)
    activate MIG
    Note over MIG: bin/rails db:prepare<br/>restart: "no"
    MIG-->>MIG: exit 0 (completed_successfully)
    deactivate MIG

    par 并行启动
        User->>APP: depends_on db + migrator
        activate APP
        Note over APP: bin/thrust bin/rails server<br/>端口 8080→80
        APP-->>APP: healthcheck: curl /up
        deactivate APP
    and
        User->>JOBS: depends_on db + migrator
        activate JOBS
        Note over JOBS: bin/jobs (Solid Queue)
        deactivate JOBS
    end
```

`migrator` 服务设置 `restart: "no"`，确保迁移只执行一次。若迁移失败则 `service_completed_successfully` 条件不满足，`app` 和 `jobs` 不会启动——这是防止应用连接未迁移数据库的关键保护。

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L51-L65)

### 数据库服务

Core Matrix 使用 `pgvector/pgvector:pg18-trixie` 镜像，在 PostgreSQL 18 基础上内置 pgvector 扩展，支持向量相似度搜索场景。数据库配置要点如下：

| 参数 | 值 | 说明 |
|------|-----|------|
| 镜像 | `pgvector/pgvector:pg18-trixie` | PostgreSQL 18 + pgvector 扩展 |
| PGDATA | `/var/lib/postgresql/data/18` | 明确版本化路径，便于未来升级 |
| 密码 | `${POSTGRES_PASSWORD:-postgres}` | 通过 `.env` 注入，默认值仅用于开发 |
| CPU 限制 | 2 核 / 预留 0.5 核 | 生产环境建议根据负载调整 |
| 内存限制 | 2GB / 预留 512MB | 适合中小规模部署 |
| 日志轮转 | json-file, 10MB × 3 文件 | 防止磁盘被日志占满 |

Production 环境下 Core Matrix 使用**四数据库架构**：`primary`（业务数据）、`cache`（Solid Cache）、`queue`（Solid Queue）、`cable`（Solid Cable），共享同一 PostgreSQL 实例但使用独立数据库。连接字符串通过 `RAILS_DB_URL_BASE` 环境变量统一注入，格式为 `postgresql://postgres:密码@db`，各数据库名称由 `config/database.yml` 自动拼接。

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L19-L49), [config/database.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/database.yml#L88-L104)

### Web 应用服务

`app` 服务通过 Thruster（基于 HAProxy 的轻量反向代理）包装 Puma，对外暴露 80 端口（映射至宿主机 8080）。健康检查通过 `curl -f http://localhost/up` 验证 Rails 就绪状态，启动宽限期为 60 秒。

资源限制设置为 2 核 CPU / 2GB 内存，与数据库服务保持一致。`config.d` 目录以只读方式挂载至 `/rails/config.d`，允许在不重建镜像的情况下覆盖 LLM Provider 目录等配置。

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L66-L99)

### 后台作业服务

`jobs` 服务运行 Solid Queue 工作器，负责处理 LLM 请求、工具调用、工作流编排和维护任务。资源限制设置为 1 核 CPU / 1GB 内存，低于 Web 服务——因为作业处理主要是 I/O 密集型（等待 LLM API 响应）。

队列拓扑由 `config/runtime_topology.yml` 定义，通过 `config/queue.yml` 动态生成 Solid Queue 配置。默认拓扑包含 5 个 LLM 队列（按 Provider 隔离）、1 个工具调用队列、1 个工作流队列和 1 个维护队列，每个队列的线程数和进程数均可通过环境变量覆盖。

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L100-L123), [config/runtime_topology.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/runtime_topology.yml#L1-L66)

## Fenix 编排详解

### 服务组成

Fenix 的 `docker-compose.fenix.yml` 定义了两个服务：

| 服务 | 命令 | 端口映射 | 持久化卷 |
|------|------|---------|---------|
| `fenix` | `bin/thrust bin/rails server` | `3101:80` | `fenix_storage` → `/rails/storage`，工作区 → `/workspace` |
| `fenix-dev-proxy` | `/rails/bin/fenix-dev-proxy` | `3310:3310` | 共享 `fenix_proxy_routes` → `/rails/tmp/dev-proxy` |

`fenix` 服务是主运行时，承载 Puma Web 服务器和 Solid Queue（通过 Puma 插件内嵌运行）。`fenix-dev-proxy` 服务运行 Caddy 反向代理，用于浏览器预览验证。两者通过 `fenix_proxy_routes` 卷共享 Caddy 路由配置文件。

Fenix 使用 **SQLite 数据库**（区别于 Core Matrix 的 PostgreSQL），数据库文件存储在 `/rails/storage` 目录中，通过 `fenix_storage` 卷持久化。同样采用双数据库架构：`primary`（业务数据）和 `queue`（Solid Queue），连接池大小分别由 `FENIX_PRIMARY_DB_POOL` 和 `FENIX_QUEUE_DB_POOL` 控制。

Sources: [docker-compose.fenix.yml](https://github.com/jasl/cybros.new/blob/main/agents/fenix/docker-compose.fenix.yml#L1-L31), [config/database.yml](https://github.com/jasl/cybros.new/blob/main/agents/fenix/config/database.yml#L1-L52)

### Core Matrix 与 Fenix 的互联

当 Fenix 作为代理运行时与 Core Matrix 配对部署时，需配置以下连接参数：

| 环境变量 | Fenix 侧值 | 说明 |
|---------|-----------|------|
| `CORE_MATRIX_BASE_URL` | `http://core-matrix:3000` | Core Matrix 控制平面地址（同一 Docker 网络内） |
| `CORE_MATRIX_MACHINE_CREDENTIAL` | （机密值） | 代理程序机器凭证，用于 Program API 认证 |
| `FENIX_PUBLIC_BASE_URL` | `http://fenix:80` | Fenix 对外可达的公开地址（Core Matrix 回调用） |

在验收测试场景中，`acceptance/bin/activate_fenix_docker_runtime.sh` 脚本演示了完整的 Fenix Docker 运行时激活流程：构建镜像 → 启动容器 → 等待健康检查 → 执行运行时依赖引导 → 启动 `runtime-worker` 进程。当 Core Matrix 运行在宿主机而 Fenix 运行在 Docker 中时，`CORE_MATRIX_BASE_URL` 应设置为 `http://host.docker.internal:3000`。

Sources: [env.sample](https://github.com/jasl/cybros.new/blob/main/agents/fenix/env.sample#L36-L48), [activate_fenix_docker_runtime.sh](https://github.com/jasl/cybros.new/blob/main/acceptance/bin/activate_fenix_docker_runtime.sh#L181-L197)

## 环境变量参考

### 必需变量

以下环境变量在生产部署中必须配置：

| 变量 | 适用组件 | 生成方式 | 说明 |
|------|---------|---------|------|
| `POSTGRES_PASSWORD` | Core Matrix | `openssl rand -base64 32` | PostgreSQL 超级用户密码 |
| `SECRET_KEY_BASE` | 两者 | `bin/rails secret` | Rails 会话签名和消息验证密钥 |
| `ACTIVE_RECORD_ENCRYPTION__PRIMARY_KEY` | 两者 | `bin/rails db:encryption:init` | Active Record 加密主密钥 |
| `ACTIVE_RECORD_ENCRYPTION__DETERMINISTIC_KEY` | 两者 | 同上 | 确定性加密密钥（可搜索加密） |
| `ACTIVE_RECORD_ENCRYPTION__KEY_DERIVATION_SALT` | 两者 | 同上 | 密钥派生盐值 |
| `CORE_MATRIX_MACHINE_CREDENTIAL` | Fenix | Core Matrix 管理界面生成 | 代理程序机器凭证 |
| `RAILS_DB_URL_BASE` | Core Matrix | 根据部署拓扑构造 | 格式：`postgresql://user:pass@host` |

Sources: [env.sample (Core Matrix)](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L16-L43), [env.sample (Fenix)](https://github.com/jasl/cybros.new/blob/main/agents/fenix/env.sample#L36-L74)

### 性能调优变量

以下变量具有合理的默认值，仅在需要偏离基线时才需显式设置。默认值针对 4 核 / 8GB 内存的基准宿主机构型设计。

**Core Matrix 调优参数：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RAILS_MAX_THREADS` | 3 | Puma 每个 worker 的线程数 |
| `RAILS_WEB_CONCURRENCY` | 1 | Puma worker 进程数 |
| `RAILS_DB_POOL` | max(16, RAILS_MAX_THREADS) | 数据库连接池大小 |
| `SOLID_QUEUE_IN_PUMA` | false | 是否在 Puma 进程内运行 Solid Queue |
| `SQ_THREADS_LLM_OPENAI` | 3 | OpenAI LLM 队列线程数 |
| `SQ_THREADS_TOOL_CALLS` | 6 | 工具调用队列线程数 |
| `SQ_THREADS_WORKFLOW_DEFAULT` | 3 | 工作流队列线程数 |

**Fenix 调优参数：**

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FENIX_PRIMARY_DB_POOL` | 8 | 主库连接池大小 |
| `FENIX_QUEUE_DB_POOL` | 16 | 队列库连接池大小 |
| `SQ_THREADS_PURE_TOOLS` | 6 | 纯工具执行线程数 |
| `SQ_THREADS_PROCESS_TOOLS` | 2 | 进程工具执行线程数 |
| `SQ_THREADS_RUNTIME_CONTROL` | 2 | 运行时控制线程数 |
| `STANDALONE_SOLID_QUEUE` | 未设置 | 设为 `true` 时独立运行 Solid Queue |

Sources: [env.sample (Core Matrix)](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L82-L120), [env.sample (Fenix)](https://github.com/jasl/cybros.new/blob/main/agents/fenix/env.sample#L86-L139)

## 运行时配置覆盖机制

Core Matrix 的 compose 编排将 `./config.d` 目录以只读方式挂载至容器内 `/rails/config.d`，实现**运行时配置覆盖而不重建镜像**。这一机制的典型应用场景是 LLM Provider 目录定制：

1. 将 `config.d/llm_catalog.yml.sample` 复制为 `config.d/llm_catalog.yml`
2. 按需添加或修改 Provider 和模型定义
3. 重启容器即可生效，无需重新构建镜像

覆盖文件支持深度合并策略：Hash 类型键递归合并，Array 类型键整体替换。API 密钥等敏感信息不应放在此目录中，而应通过 `.env` 文件或 Rails credentials 管理。

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L15-L17), [llm_catalog.yml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/config.d/llm_catalog.yml.sample#L1-L18)

## 快速部署指南

### Core Matrix 独立部署

```mermaid
flowchart TD
    A["cp env.sample .env"] --> B["编辑 .env<br/>填写密码和密钥"]
    B --> C["cp compose.yaml.sample compose.yaml"]
    C --> D["可选：定制 config.d/"]
    D --> E["docker compose build"]
    E --> F["docker compose up -d"]
    F --> G{"curl http://localhost:8080/up"}
    G -->|200 OK| H["✅ 部署成功"]
    G -->|超时| I["检查 docker compose logs"]
    I --> G
```

操作步骤如下：

1. 进入 `core_matrix/` 目录，复制环境模板：`cp env.sample .env`
2. 编辑 `.env`，填写 `POSTGRES_PASSWORD`、`SECRET_KEY_BASE` 和三组 Active Record Encryption 密钥
3. 复制编排文件：`cp compose.yaml.sample compose.yaml`（该文件已在 `.dockerignore` 和 `.gitignore` 中被忽略）
4. 如需定制 LLM Provider，编辑 `config.d/llm_catalog.yml`
5. 构建并启动：`docker compose build && docker compose up -d`
6. 验证健康状态：`curl -f http://localhost:8080/up`

Sources: [env.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L1-L14), [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L1-L127)

### Core Matrix + Fenix 联合部署

当需要部署完整的代理运行时能力时，在 Core Matrix 基础上追加 Fenix 服务。关键步骤：

1. 确保 Core Matrix 已正常运行且可访问
2. 在 Core Matrix 中为目标代理程序创建机器凭证（用于 `CORE_MATRIX_MACHINE_CREDENTIAL`）
3. 进入 `agents/fenix/` 目录，复制 `env.sample` 为 `.env`
4. 填写 `SECRET_KEY_BASE`、Active Record Encryption 密钥、`CORE_MATRIX_BASE_URL` 和 `CORE_MATRIX_MACHINE_CREDENTIAL`
5. 启动：`docker compose -f docker-compose.fenix.yml up -d`
6. 验证 Fenix 健康状态：`curl -f http://localhost:3101/up`
7. 验证运行时注册：`curl -f http://localhost:3101/runtime/manifest`

如果两个 compose 编排运行在同一 Docker 主机上，可以创建共享网络使 Fenix 通过服务名访问 Core Matrix，此时 `CORE_MATRIX_BASE_URL` 应设置为 `http://core-matrix-app:80`（需确保 Core Matrix 的 app 服务加入了共享网络）。

Sources: [docker-compose.fenix.yml](https://github.com/jasl/cybros.new/blob/main/agents/fenix/docker-compose.fenix.yml#L1-L31), [activate_fenix_docker_runtime.sh](https://github.com/jasl/cybros.new/blob/main/acceptance/bin/activate_fenix_docker_runtime.sh#L162-L197)

## 开发容器配置

除生产 Docker Compose 外，Core Matrix 在 `.devcontainer/` 中提供了 VS Code Dev Containers / GitHub Codespaces 的开发环境配置。该配置使用 `ghcr.io/rails/devcontainer/images/ruby` 预构建镜像，配合 PostgreSQL 18 和 Selenium Chromium 两个辅助服务，通过 `postCreateCommand` 自动执行 `bin/setup --skip-server` 完成环境初始化。此配置仅用于开发场景，不应用于生产部署。

Sources: [.devcontainer/devcontainer.json](https://github.com/jasl/cybros.new/blob/main/core_matrix/.devcontainer/devcontainer.json#L1-L35), [.devcontainer/compose.yaml](https://github.com/jasl/cybros.new/blob/main/core_matrix/.devcontainer/compose.yaml#L1-L41)

## 常见问题排查

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| `app` 服务无法启动 | 数据库迁移失败 | `docker compose logs migrator` 查看迁移日志 |
| Fenix 容器启动后立即退出 | `.env` 文件缺失或变量未填写 | 确认 `.env` 中所有必需变量已设置 |
| `db` 健康检查超时 | PostgreSQL 初始化慢或资源不足 | 增大 `start_period` 或提升 `db` 服务的内存限制 |
| LLM 请求 403/401 | Provider API 密钥未配置 | 检查 `.env` 或 Rails credentials 中的 API 密钥 |
| Fenix 无法连接 Core Matrix | 网络不可达或地址配置错误 | 验证 `CORE_MATRIX_BASE_URL`，在 Fenix 容器内 `curl` 测试连通性 |
| Solid Queue 无法启动 | 数据库连接池过小 | 确保 `RAILS_DB_POOL` ≥ 所有队列线程数之和 + 2 |
| 容器内文件权限错误 | 卷挂载权限不匹配 | Fenix 入口点会自动修复，Core Matrix 确保使用 uid 1000 |

Sources: [compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L76-L81), [env.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L80-L83), [bin/docker-entrypoint](https://github.com/jasl/cybros.new/blob/main/agents/fenix/bin/docker-entrypoint#L1-L32)

---

**下一步阅读**：了解 Core Matrix 的内部架构，请参阅 [六大限界上下文与领域模型总览](https://github.com/jasl/cybros.new/blob/main/4-liu-da-xian-jie-shang-xia-wen-yu-ling-yu-mo-xing-zong-lan)。关于 Fenix 代理程序如何与 Core Matrix 协同工作，请参阅 [Fenix 产品定位与配对清单契约](https://github.com/jasl/cybros.new/blob/main/19-fenix-chan-pin-ding-wei-yu-pei-dui-qing-dan-qi-yue)。队列拓扑的详细设计请参阅 [运行时拓扑与 Solid Queue 队列配置](https://github.com/jasl/cybros.new/blob/main/18-yun-xing-shi-tuo-bu-yu-solid-queue-dui-lie-pei-zhi)。