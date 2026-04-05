本指南面向初次接触 Cybros 单仓库的开发者，系统性地讲解如何从零搭建本地开发环境、理解启动流程、配置关键参数，并成功运行完整的开发服务器。Cybros 由 **Core Matrix** 内核平台和 **Fenix** 代理程序两个 Rails 应用组成，它们共享一套基于 foreman 的进程管理架构，但拥有各自独立的依赖栈和数据库。阅读完本文后，你将拥有一个可以正常工作的本地开发实例，并理解每个配置项的作用。

Sources: [README.md](https://github.com/jasl/cybros.new/blob/main/README.md#L1-L66), [AGENTS.md](https://github.com/jasl/cybros.new/blob/main/AGENTS.md#L1-L63)

## 先决条件与版本要求

Cybros 的两个子项目各有独立的运行时依赖。在开始之前，请确认本地已安装以下工具链：

| 依赖项 | Core Matrix 要求 | Fenix 要求 | 用途 |
|--------|------------------|------------|------|
| **Ruby** | 4.0.2 | 4.0.2 | 主运行时（两个项目锁定同一版本） |
| **PostgreSQL** | ≥ 18（带 pgvector 扩展） | 不需要 | Core Matrix 主数据库 |
| **Bun** | ≥ 1.3.x | 不需要 | JS/CSS 打包（仅 Core Matrix） |
| **SQLite** | 不需要 | ≥ 2.1（gem 自带） | Fenix 本地数据库 |
| **Node.js** | 不需要 | 24（用于 Playwright） | Fenix 浏览器自动化 |
| **Python** | 不需要 | 3.12 | Fenix 脚本运行时（可选） |
| **Foreman** | 自动安装 | 自动安装 | 多进程开发管理器 |

**关键说明**：Core Matrix 的生产 Docker 镜像使用 `pgvector/pgvector:pg18-trixie` 镜像，其中包含 PostgreSQL 18 和 pgvector 扩展。本地开发环境如果使用原生 PostgreSQL，需确保安装了 pgvector 扩展。开发环境中 **Bun** 仅用于 Core Matrix 的前端资源打包（通过 `bun.config.js` 监听 `app/javascript` 目录并输出到 `app/assets/builds`），Fenix 不使用 Bun 而是使用 npm 管理其 Playwright 依赖。

Sources: [core_matrix/.ruby-version](https://github.com/jasl/cybros.new/blob/main/core_matrix/.ruby-version#L1-L2), [agents/fenix/.ruby-version](https://github.com/jasl/cybros.new/blob/main/agents/fenix/.ruby-version#L1-L2), [core_matrix/Dockerfile](https://github.com/jasl/cybros.new/blob/main/core_matrix/Dockerfile#L11-L12), [core_matrix/compose.yaml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/compose.yaml.sample#L21-L22), [agents/fenix/.node-version](https://github.com/jasl/cybros.new/blob/main/agents/fenix/.node-version#L1-L2), [agents/fenix/.python-version](https://github.com/jasl/cybros.new/blob/main/agents/fenix/.python-version#L1-L2), [core_matrix/Gemfile](https://github.com/jasl/cybros.new/blob/main/core_matrix/Gemfile#L22-L26)

## 架构总览：开发环境中的进程拓扑

在深入配置步骤之前，理解 Cybros 开发环境运行时会启动哪些进程至关重要。下图展示了从仓库根目录启动 `bin/dev` 时的完整进程拓扑：

```mermaid
graph TB
    subgraph "单仓库根目录 bin/dev"
        A["bin/dev<br/>(根入口)"] --> B["MonorepoDevEnvironment<br/>环境变量初始化"]
        A --> C["foreman<br/>(进程管理器)"]
        A --> D["Rails server<br/>(Core Matrix Puma)"]
    end

    subgraph "Foreman 管理的进程"
        C --> E["job<br/>cd core_matrix && bin/jobs<br/>(Solid Queue 工作器)"]
        C --> F["js<br/>cd core_matrix && bun build --watch<br/>(JS 热重载)"]
        C --> G["css<br/>cd core_matrix && bun build:css --watch<br/>(CSS 热重载)"]
        C --> H["agent_fenix<br/>cd agents/fenix && bin/dev<br/>(Fenix 子进程)"]
    end

    subgraph "Core Matrix 数据库"
        D --- I[("primary<br/>core_matrix_primary_development")]
        E --- I
        E --- J[("queue<br/>core_matrix_queue_development")]
        D --- K[("cable<br/>core_matrix_cable_development")]
    end

    subgraph "端口分配"
        D -.->|"3000"| L["Core Matrix API"]
        H -.->|"36173"| M["Fenix Runtime"]
    end

    style A fill:#2563eb,color:#fff
    style C fill:#7c3aed,color:#fff
    style D fill:#059669,color:#fff
    style H fill:#d97706,color:#fff
```

**核心设计要点**：`bin/dev`（根目录入口）是一个 Ruby 脚本，它首先通过 `MonorepoDevEnvironment` 模块注入默认环境变量（端口号、服务 URL），然后同时启动 **Rails server** 和 **foreman** 进程管理器。Foreman 读取根目录的 `Procfile.dev`，按需启动后台作业工作器、前端构建监视器和 Fenix 子进程。Rails server 和 foreman 是两个独立的顶层进程，当 Rails server 退出时，`bin/dev` 会发送 `INT` 信号给 foreman 进程组，确保所有子进程干净退出。

Sources: [bin/dev](https://github.com/jasl/cybros.new/blob/main/bin/dev#L1-L55), [lib/monorepo_dev_environment.rb](https://github.com/jasl/cybros.new/blob/main/lib/monorepo_dev_environment.rb#L1-L22), [Procfile.dev](https://github.com/jasl/cybros.new/blob/main/Procfile.dev#L1-L5), [core_matrix/Procfile.dev](https://github.com/jasl/cybros.new/blob/main/core_matrix/Procfile.dev#L1-L5)

## 步骤一：Core Matrix 环境配置

Core Matrix 是整个平台的核心，它依赖 PostgreSQL 多数据库架构和 Solid Queue 后台任务系统。以下是从零开始的配置流程：

```mermaid
flowchart TD
    A["克隆仓库"] --> B["安装 Ruby 4.0.2"]
    B --> C["安装 PostgreSQL 18 + pgvector"]
    C --> D["安装 Bun"]
    D --> E["cd core_matrix"]
    E --> F["bundle install"]
    F --> G["bun install"]
    G --> H["cp env.sample .env"]
    H --> I["编辑 .env 填入配置"]
    I --> J["bin/rails db:prepare"]
    J --> K["环境就绪 ✓"]

    style A fill:#2563eb,color:#fff
    style K fill:#059669,color:#fff
```

### 1.1 克隆仓库并安装基础工具

```bash
git clone <repository-url> cybros.new
cd cybros.new
```

确保已通过版本管理器（如 `rbenv`、`rvm` 或 `mise`）安装 **Ruby 4.0.2**。项目根目录和两个子项目都有各自的 `.ruby-version` 文件，内容均为 `4.0.2`。

Sources: [core_matrix/.ruby-version](https://github.com/jasl/cybros.new/blob/main/core_matrix/.ruby-version#L1-L2), [agents/fenix/.ruby-version](https://github.com/jasl/cybros.new/blob/main/agents/fenix/.ruby-version#L1-L2)

### 1.2 PostgreSQL 数据库准备

Core Matrix 在开发环境中使用 **三个独立数据库**，全部由同一个 PostgreSQL 实例承载：

| 数据库名称 | 用途 | 配置来源 |
|-----------|------|---------|
| `core_matrix_primary_development` | 主业务数据 | `config/database.yml` → `primary` |
| `core_matrix_queue_development` | Solid Queue 后台任务 | `config/database.yml` → `queue` |
| `core_matrix_cable_development` | Action Cable 实时通信 | `config/database.yml` → `cable` |

如果 PostgreSQL 运行在默认的 Unix socket 或 localhost:5432 上，**不需要任何额外配置**，`bin/rails db:prepare` 会自动创建这些数据库并运行迁移。如果 PostgreSQL 运行在其他位置，请在 `.env` 中设置 `RAILS_DB_URL_BASE`，例如：

```bash
# .env 文件
RAILS_DB_URL_BASE=postgresql://postgres:postgres@localhost:5432
```

Sources: [core_matrix/config/database.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/database.yml#L15-L46), [core_matrix/env.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L50-L55)

### 1.3 安装依赖

在 `core_matrix` 目录下执行：

```bash
cd core_matrix
bundle install          # 安装 Ruby 依赖（包含 Rails main 分支）
bun install             # 安装前端依赖（Tailwind CSS 4, Stimulus, Turbo 等）
```

**注意事项**：Core Matrix 的 `Gemfile` 使用了 Rails 主分支（`gem "rails", github: "rails/rails", branch: "main"`），首次 `bundle install` 可能需要较长时间。此外，`vendor/simple_inference` 是一个内嵌的本地 gem，通过 `path` 方式引用。

Sources: [core_matrix/Gemfile](https://github.com/jasl/cybros.new/blob/main/core_matrix/Gemfile#L1-L62), [core_matrix/bin/setup](https://github.com/jasl/cybros.new/blob/main/core_matrix/bin/setup#L14-L20)

### 1.4 环境变量配置

Core Matrix 的环境变量模板位于 `env.sample`，复制并按需填写：

```bash
cp env.sample .env
```

对于**纯本地开发**，绝大多数变量可以保持默认。以下是按优先级排列的配置清单：

| 变量名 | 是否必须 | 默认值 | 说明 |
|--------|---------|--------|------|
| `RAILS_DB_URL_BASE` | 条件必须 | 无（使用 socket） | 远程 PostgreSQL 时必填 |
| `SECRET_KEY_BASE` | 仅生产 | 无 | 开发环境自动生成 |
| `ACTIVE_RECORD_ENCRYPTION__*` | 仅生产 | 无 | 数据库加密密钥 |
| `RAILS_MAX_THREADS` | 可选 | 3 | Puma 每个工作线程数 |
| `RAILS_DB_POOL` | 可选 | 16 | 数据库连接池大小 |
| `SOLID_QUEUE_IN_PUMA` | 可选 | false | 是否在 Puma 内嵌运行 SolidQueue |

如果你需要连接真实的 LLM API 进行端到端测试，还需要配置以下变量（它们会在 `db:seed` 时被读取并持久化为 ProviderCredential）：

| 变量名 | 用途 |
|--------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `OPENROUTER_API_KEY` | OpenRouter API 密钥 |

Sources: [core_matrix/env.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L1-L140), [core_matrix/db/seeds.rb](https://github.com/jasl/cybros.new/blob/main/core_matrix/db/seeds.rb#L70-L86)

### 1.5 数据库初始化

```bash
bin/rails db:prepare
```

此命令会自动创建三个数据库、运行所有迁移、并加载种子数据。种子数据（`db/seeds.rb`）会执行以下操作：注册内嵌代理运行时、为 `dev` provider 创建默认策略和配额、以及（如果提供了 API 密钥）为 OpenAI/OpenRouter 创建凭据和策略。

如果需要完全重置数据库：

```bash
bin/rails db:reset
```

Sources: [core_matrix/bin/setup](https://github.com/jasl/cybros.new/blob/main/core_matrix/bin/setup#L26-L28), [core_matrix/db/seeds.rb](https://github.com/jasl/cybros.new/blob/main/core_matrix/db/seeds.rb#L1-L90)

## 步骤二：Fenix 代理程序环境配置

Fenix 是 Cybros 的默认代理程序，它使用 **SQLite** 作为数据库（无需 PostgreSQL），但需要 Node.js 和 Python 来支持浏览器自动化功能。Fenix 的配置流程相对简化：

```bash
cd agents/fenix
bundle install          # Ruby 依赖（Rails main + SQLite + WebSocket）
npm install             # Node.js 依赖（Playwright 浏览器自动化）
```

Fenix 同样提供了 `env.sample` 文件，但对于本地开发，最关键的是与 Core Matrix 的配对配置：

| 变量名 | 开发环境默认值 | 说明 |
|--------|--------------|------|
| `CORE_MATRIX_BASE_URL` | `http://127.0.0.1:3000` | Core Matrix 控制平面地址 |
| `CORE_MATRIX_MACHINE_CREDENTIAL` | 无 | 与 Core Matrix 配对的机器凭据 |
| `FENIX_PUBLIC_BASE_URL` | `http://localhost:3101` | Fenix 对外暴露的基础 URL |

**独立运行说明**：Fenix 的 Docker 生产配置暴露端口 3101，但通过单仓库 `Procfile.dev` 启动时，Fenix 使用端口 **36173**（由 `MonorepoDevEnvironment::AGENT_FENIX_PORT` 定义）。如果只单独启动 Core Matrix，Fenix 相关的配置可以暂时跳过。

Sources: [agents/fenix/env.sample](https://github.com/jasl/cybros.new/blob/main/agents/fenix/env.sample#L1-L139), [agents/fenix/Gemfile](https://github.com/jasl/cybros.new/blob/main/agents/fenix/Gemfile#L1-L40), [agents/fenix/package.json](https://github.com/jasl/cybros.new/blob/main/agents/fenix/package.json#L1-L10), [lib/monorepo_dev_environment.rb](https://github.com/jasl/cybros.new/blob/main/lib/monorepo_dev_environment.rb#L5-L6)

## 步骤三：启动开发服务器

Cybros 提供了两种启动方式：**单仓库模式**（同时启动所有服务）和**单项目模式**（只启动 Core Matrix）。

### 3.1 单仓库模式（推荐）

从仓库根目录执行：

```bash
bin/dev
```

这个命令的工作原理如下：首先，它加载 `MonorepoDevEnvironment.defaults` 注入环境变量（`PORT=3000`、`AGENT_FENIX_PORT=36173`、`AGENT_FENIX_BASE_URL` 等）。然后，它同时启动两个并行进程——一个直接运行 `core_matrix/bin/rails server`，另一个通过 foreman 读取根目录 `Procfile.dev` 启动以下辅助服务：

| 进程名 | 命令 | 功能 |
|--------|------|------|
| `job` | `cd core_matrix && bin/jobs` | Solid Queue 后台任务工作器 |
| `js` | `cd core_matrix && bun run build --watch` | JavaScript 文件监听与热重载 |
| `css` | `cd core_matrix && bun run build:css --watch` | Tailwind CSS 文件监听与热重载 |
| `agent_fenix` | `cd agents/fenix && bin/dev` | Fenix 代理程序 |

当 Rails server 进程退出时（例如按 `Ctrl+C`），脚本会向 foreman 进程组发送 `INT` 信号，确保所有子进程干净终止。添加 `--verbose` 或 `-v` 参数可以查看 foreman 的详细输出。

Sources: [bin/dev](https://github.com/jasl/cybros.new/blob/main/bin/dev#L1-L55), [lib/monorepo_dev_environment.rb](https://github.com/jasl/cybros.new/blob/main/lib/monorepo_dev_environment.rb#L1-L22), [Procfile.dev](https://github.com/jasl/cybros.new/blob/main/Procfile.dev#L1-L5)

### 3.2 仅启动 Core Matrix

如果不需要 Fenix，可以在 `core_matrix` 目录下单独启动：

```bash
cd core_matrix
bin/setup            # 一键式：安装依赖 → 准备数据库 → 启动服务器
```

或者更细粒度地控制：

```bash
cd core_matrix
bin/setup --skip-server    # 只安装依赖和准备数据库，不启动服务器
bin/dev                    # 手动启动开发服务器
```

Core Matrix 的 `bin/dev` 同样使用 foreman + `Procfile.dev` 模式，但其 Procfile 包含了 `web` 进程（Puma server），而单仓库根的 Procfile 没有 `web`——因为根入口自己直接启动了 Rails server。

**Core Matrix Procfile.dev 与根 Procfile.dev 对比**：

| 进程 | Core Matrix Procfile | 根 Procfile |
|------|---------------------|-------------|
| web | `bin/rails server -b 0.0.0.0` | 无（由 `bin/dev` 直接启动） |
| job | `bin/jobs` | `cd core_matrix && bin/jobs` |
| js | `bun run build --watch` | `cd core_matrix && bun run build --watch` |
| css | `bun run build:css --watch` | `cd core_matrix && bun run build:css --watch` |
| agent_fenix | 无 | `cd agents/fenix && bin/dev` |

Sources: [core_matrix/bin/dev](https://github.com/jasl/cybros.new/blob/main/core_matrix/bin/dev#L1-L42), [core_matrix/bin/setup](https://github.com/jasl/cybros.new/blob/main/core_matrix/bin/setup#L1-L39), [core_matrix/Procfile.dev](https://github.com/jasl/cybros.new/blob/main/core_matrix/Procfile.dev#L1-L5)

### 3.3 使用一键安装脚本

Core Matrix 提供了 `bin/setup` 脚本，它是幂等的（可以安全地重复运行）：

```bash
cd core_matrix
bin/setup                # 安装依赖 → 准备数据库 → 启动 dev server
bin/setup --reset        # 同上，但先重置数据库
bin/setup --skip-server  # 只准备环境，不启动服务器
```

Sources: [core_matrix/bin/setup](https://github.com/jasl/cybros.new/blob/main/core_matrix/bin/setup#L1-L39)

## 步骤四：Dev Container 方式（可选）

对于偏好容器化开发环境的开发者，Core Matrix 提供了完整的 VS Code Dev Container 配置。该配置位于 `core_matrix/.devcontainer/` 目录，包含：

| 文件 | 功能 |
|------|------|
| `devcontainer.json` | VS Code Dev Container 主配置 |
| `Dockerfile` | 基于 `ghcr.io/rails/devcontainer/images/ruby:4.0.2` |
| `compose.yaml` | 编排 Rails 应用、PostgreSQL 18 和 Selenium |

Dev Container 的 `postCreateCommand` 会自动执行 `bin/setup --skip-server`，完成依赖安装和数据库准备。容器内通过 `forwardPorts` 暴露 3000（Rails）和 5432（PostgreSQL）端口。

Sources: [core_matrix/.devcontainer/devcontainer.json](https://github.com/jasl/cybros.new/blob/main/core_matrix/.devcontainer/devcontainer.json#L1-L35), [core_matrix/.devcontainer/compose.yaml](https://github.com/jasl/cybros.new/blob/main/core_matrix/.devcontainer/compose.yaml#L1-L41), [core_matrix/.devcontainer/Dockerfile](https://github.com/jasl/cybros.new/blob/main/core_matrix/.devcontainer/Dockerfile#L1-L8)

## 配置详解：Solid Queue 与运行时拓扑

Core Matrix 使用 **Solid Queue** 作为后台任务适配器，并通过 `config/runtime_topology.yml` 定义了精细化的队列拓扑。开发环境默认拓扑如下：

```mermaid
graph LR
    subgraph "LLM Provider 队列（按 provider 隔离）"
        A1["llm_codex_subscription<br/>线程: 2, 进程: 1"]
        A2["llm_openai<br/>线程: 3, 进程: 1"]
        A3["llm_openrouter<br/>线程: 2, 进程: 1"]
        A4["llm_dev<br/>线程: 1, 进程: 1"]
        A5["llm_local<br/>线程: 1, 进程: 1"]
    end

    subgraph "共享队列"
        B1["tool_calls<br/>线程: 6, 进程: 1"]
        B2["workflow_default<br/>线程: 3, 进程: 1"]
        B3["maintenance<br/>线程: 1, 进程: 1"]
    end

    subgraph "调度器"
        C1["dispatcher<br/>轮询间隔: 1s, 批次: 500"]
    end

    C1 --> A1 & A2 & A3 & A4 & A5
    C1 --> B1 & B2 & B3
```

每个队列的线程数和进程数都可通过环境变量覆盖（例如 `SQ_THREADS_LLM_OPENAI=5`），这使得同一份 `config/queue.yml` 可以适配不同规模的部署。`config/runtime_topology.yml` 是队列拓扑的唯一数据源，`config/queue.yml` 通过 ERB 模板从中读取配置。

**连接池计算**：数据库连接池大小（`RAILS_DB_POOL`）必须满足：`>= 所有 Solid Queue 工作线程总数 + 2`。默认拓扑下总线程数约为 19，因此默认连接池为 16 可能偏紧——如果看到连接池耗尽的错误，建议显式设置 `RAILS_DB_POOL=24`。

Sources: [core_matrix/config/runtime_topology.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/runtime_topology.yml#L1-L66), [core_matrix/config/queue.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/queue.yml#L1-L47), [core_matrix/env.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/env.sample#L88-L120), [core_matrix/config/environments/development.rb](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/environments/development.rb#L31-L33)

## LLM Provider 目录配置

Core Matrix 通过 `config/llm_catalog.yml` 定义了所有可用的 LLM Provider 和模型。该目录在开发环境中默认包含以下 provider：

| Provider Handle | 显示名称 | 传输协议 | 是否需要凭据 |
|----------------|---------|---------|------------|
| `codex_subscription` | Codex Subscription | HTTPS / Responses API | 是（OAuth） |
| `openai` | OpenAI | HTTPS / Responses API | 是（API Key） |
| `openrouter` | OpenRouter | HTTPS / Chat Completions | 是（API Key） |
| `dev` | 开发 Provider | HTTPS | 否 |
| `local` | 本地模型 | HTTPS | 否（默认禁用） |

你可以通过在 `config.d/` 目录下放置 `llm_catalog.yml` 或 `llm_catalog.development.yml` 文件来覆盖基础目录。该机制支持 **深度合并**（Hash 值逐层合并）和 **数组替换**（数组直接覆盖），非常适合在不修改源文件的情况下添加自定义模型或调整参数。

Sources: [core_matrix/config/llm_catalog.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/llm_catalog.yml#L1-L200), [core_matrix/config.d/llm_catalog.yml.sample](https://github.com/jasl/cybros.new/blob/main/core_matrix/config.d/llm_catalog.yml.sample#L1-L114)

## 常见问题排查

| 问题现象 | 可能原因 | 解决方案 |
|---------|---------|---------|
| `bundle install` 失败 | Ruby 版本不匹配 | 确认 `ruby -v` 输出为 4.0.2 |
| PostgreSQL 连接被拒 | PostgreSQL 未运行或 socket 路径不正确 | 启动 PostgreSQL 或设置 `RAILS_DB_URL_BASE` |
| 数据库迁移报错 pgvector | 未安装 pgvector 扩展 | 安装 pgvector 扩展或使用 Dev Container |
| `bun: command not found` | Bun 未安装 | 安装 Bun：`curl -fsSL https://bun.sh/install \| bash` |
| Solid Queue 启动失败 | 连接池不足 | 设置 `RAILS_DB_POOL=24` 或更高 |
| Fenix 无法连接 Core Matrix | 端口或 URL 不匹配 | 确认 `CORE_MATRIX_BASE_URL=http://127.0.0.1:3000` |
| 前端资源 404 | JS/CSS 未构建 | 确认 foreman 的 js/css 进程正常运行 |
| `web-console` 加载失败 | 环境不对 | 确认 `RAILS_ENV=development`（默认值） |

Sources: [core_matrix/config/database.yml](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/database.yml#L15-L104), [core_matrix/config/puma.rb](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/puma.rb#L28-L37), [core_matrix/config/environments/development.rb](https://github.com/jasl/cybros.new/blob/main/core_matrix/config/environments/development.rb#L1-L86)

## 验证命令速查

成功启动后，可以通过以下命令验证环境完整性。这些命令与 CI 流水线使用的验证步骤一致：

```bash
# Core Matrix 验证（在 core_matrix 目录下执行）
cd core_matrix
bin/rails db:test:prepare test       # 单元/集成测试
bin/rails db:test:prepare test:system # 系统测试
bin/brakeman --no-pager               # 安全扫描
bin/bundler-audit                     # 依赖漏洞检查
bin/rubocop -f github                 # 代码风格检查
bun run lint:js                       # JavaScript 代码风格检查

# Fenix 验证（在 agents/fenix 目录下执行）
cd agents/fenix
bin/rails db:test:prepare test        # 单元测试
bin/brakeman --no-pager               # 安全扫描
bin/bundler-audit                     # 依赖漏洞检查
bin/rubocop -f github                 # 代码风格检查
```

Sources: [AGENTS.md](https://github.com/jasl/cybros.new/blob/main/AGENTS.md#L34-L55)

## 下一步

环境搭建完成后，建议按以下顺序深入学习：

1. **[Docker Compose 部署参考](https://github.com/jasl/cybros.new/blob/main/3-docker-compose-bu-shu-can-kao)** — 了解如何通过容器化方式部署完整的生产级 Cybros 堆栈
2. **[六大限界上下文与领域模型总览](https://github.com/jasl/cybros.new/blob/main/4-liu-da-xian-jie-shang-xia-wen-yu-ling-yu-mo-xing-zong-lan)** — 理解 Core Matrix 的核心领域架构和数据库表结构
3. **[LLM Provider 目录与模型选择解析](https://github.com/jasl/cybros.new/blob/main/11-llm-provider-mu-lu-yu-mo-xing-xuan-ze-jie-xi)** — 深入了解 Provider 目录的配置机制和模型角色选择策略
4. **[运行时拓扑与 Solid Queue 队列配置](https://github.com/jasl/cybros.new/blob/main/18-yun-xing-shi-tuo-bu-yu-solid-queue-dui-lie-pei-zhi)** — 掌握队列调优和生产环境拓扑规划