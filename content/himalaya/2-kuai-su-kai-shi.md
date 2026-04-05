本文档帮助你快速搭建 Himalaya 渲染器的开发环境，并成功运行第一个渲染场景。整个流程约需 15-30 分钟，取决于你的网络环境和硬件配置。

Himalaya 是一个基于 **Vulkan 1.4** 的实时渲染器，采用四层架构设计（RHI → Framework → Passes → App），以光栅化渲染为起步，已集成路径追踪参考视图。项目使用 **vcpkg** 管理第三方依赖，**CMake 4.1+** 构建系统，**C++20** 标准。

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L1-L30)

## 环境要求

在开始之前，请确认你的开发环境满足以下要求：

| 组件 | 最低版本 | 说明 |
|------|----------|------|
| 操作系统 | Windows 10/11 | 当前主要支持 Windows 平台 |
| IDE | CLion 2024.x | 推荐，支持 Ninja 和 vcpkg 集成 |
| 编译器 | MSVC 2022 | Visual Studio 17.0 或更新版本 |
| CMake | 4.1+ | 项目根目录已配置 `cmake_minimum_required` |
| Vulkan SDK | 1.4+ | 需要 RT 扩展支持以启用路径追踪功能 |
| ISPC 编译器 | 1.30+ | 用于 BC7 纹理压缩的 SIMD 加速 |
| GPU | 支持 Vulkan 1.4 | NVIDIA RTX 20+/AMD RX 6000+ 可获得完整功能 |

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L15-L26)

## 获取源码与依赖

### 1. 克隆仓库

```bash
git clone https://github.com/yourusername/himalaya.git
cd himalaya
```

### 2. 安装 vcpkg 依赖

项目使用 vcpkg manifest 模式管理依赖，首次构建时 CMake 会自动下载并编译以下库：

| 库 | 用途 |
|----|------|
| GLFW3 | 窗口管理与输入处理 |
| GLM | 数学库（向量、矩阵、变换） |
| spdlog | 日志系统 |
| VMA | Vulkan 内存分配管理 |
| shaderc | 运行时 GLSL → SPIR-V 编译 |
| Dear ImGui | 调试 UI 面板 |
| fastgltf | glTF 2.0 场景加载 |
| stb | JPEG/PNG 图像解码 |
| nlohmann-json | 配置持久化 |
| xxHash | 内容哈希缓存 |
| mikktspace | 切线空间计算 |

Sources: [vcpkg.json](https://github.com/1PercentSync/himalaya/blob/main/vcpkg.json#L1-L40)

**首次构建耗时说明**：vcpkg 需要从源码编译依赖库（约 15-30 分钟），后续构建将直接使用缓存。

## 构建与运行

### 3. CMake 配置（CLion 方式）

1. 在 CLion 中打开项目根目录
2. 进入 **File → Settings → Build, Execution, Deployment → CMake**
3. 配置 CMake 选项：
   - **Build type**: `Debug` 或 `Release`
   - **Toolchain**: 选择 MSVC 工具链
   - **Generator**: Ninja（推荐）或 Visual Studio

### 4. 构建项目

点击 CLion 的构建按钮或运行：

```bash
cmake -B cmake-build-debug -S . -DCMAKE_TOOLCHAIN_FILE=<vcpkg-root>/scripts/buildsystems/vcpkg.cmake
cmake --build cmake-build-debug --target himalaya_app
```

构建完成后，你将看到以下输出结构：

```
cmake-build-debug/
├── app/
│   ├── himalaya_app.exe      # 可执行文件
│   ├── shaders/              # 自动拷贝的着色器
│   └── *.dll                 # 运行时依赖库
├── framework/                # himalaya_framework.lib
├── passes/                   # himalaya_passes.lib
└── rhi/                      # himalaya_rhi.lib
```

Sources: [app/CMakeLists.txt](https://github.com/1PercentSync/himalaya/blob/main/app/CMakeLists.txt#L22-L29)

### 5. 运行程序

```bash
./cmake-build-debug/app/himalaya_app.exe
```

首次启动将自动创建 `config.json` 配置文件。

## 基本操作指南

### 场景加载

启动后，按以下步骤加载示例场景：

1. **点击左上角 "Load Scene"** 按钮
2. 在文件对话框中选择 `assets/Sponza/Sponza.gltf`（经典测试场景）
3. 场景加载后，相机会自动定位到场景中心

或者通过 **"Load Environment"** 按钮加载 HDR 环境贴图（如 `assets/environment.hdr`）以增强光照效果。

Sources: [app/include/himalaya/app/application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L298-L316)

### 相机控制

| 操作 | 功能 |
|------|------|
| **W/A/S/D** | 前后左右移动 |
| **鼠标拖动** | 旋转视角 |
| **滚轮** | 调整移动速度 |
| **左键拖动** | 旋转 IBL 环境光方向 |

Sources: [app/include/himalaya/app/camera_controller.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/camera_controller.h)

### 调试面板功能

按 **~** 键或点击 ImGui 面板可调整以下渲染参数：

| 面板 | 功能 |
|------|------|
| **Renderer** | 切换光栅化/路径追踪模式、Debug 可视化模式 |
| **Lighting** | 调整 IBL 强度、曝光值(EV) |
| **Shadows** | CSM 级联数量、PCSS 软阴影开关、光源角度 |
| **AO** | GTAO 半径、采样方向数、时域混合系数 |
| **PT** | 路径追踪采样数、最大深度、Russian Roulette 开关 |
| **Features** | 开关各项效果（Skybox/Shadows/AO/Contact Shadows） |

Sources: [app/include/himalaya/app/debug_ui.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/debug_ui.h)

## 渲染模式切换

Himalaya 支持两种渲染模式，可通过 ImGui 面板实时切换：

| 模式 | 特点 | 适用场景 |
|------|------|----------|
| **Rasterization** | 实时 PBR 光栅化，包含 CSM 阴影、GTAO、Contact Shadows | 实时预览、交互操作 |
| **Path Tracing** | 路径追踪参考视图，支持累积采样 + OIDN 降噪 | 画质参考、离线渲染验证 |

模式切换时会自动清理历史缓存，确保渲染结果正确。

Sources: [app/include/himalaya/app/application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L158-L159)

## 项目结构速览

理解项目结构有助于你快速定位代码：

```
himalaya/
├── rhi/                 # Layer 0: Vulkan 抽象层
│   ├── context.h        # Instance, Device, Queue 管理
│   ├── resources.h      # Buffer, Image, Sampler 创建
│   ├── descriptors.h    # Bindless 描述符管理
│   └── commands.h       # Command Buffer 辅助
├── framework/           # Layer 1: 渲染框架
│   ├── render_graph.h   # Render Graph 资源管理
│   ├── material_system.h # 材质模板与实例
│   ├── mesh.h           # 几何数据管理
│   ├── camera.h         # 相机与投影
│   └── scene_data.h     # 场景渲染数据结构
├── passes/              # Layer 2: 渲染 Pass 实现
│   ├── forward_pass.cpp # 前向渲染
│   ├── gtao_pass.cpp    # 环境光遮蔽
│   ├── shadow_pass.cpp  # 级联阴影映射
│   └── skybox_pass.cpp  # 天空盒渲染
├── app/                 # Layer 3: 应用层
│   ├── application.cpp   # 主循环与初始化
│   ├── scene_loader.cpp  # glTF 场景加载
│   ├── camera_controller.cpp # 相机控制
│   └── renderer.cpp      # 渲染管线编排
└── shaders/             # GLSL 着色器源码
    ├── common/           # 公共工具函数库
    ├── forward.*         # 前向渲染着色器
    ├── rt/               # 光线追踪着色器组
    └── *.comp            # 计算着色器
```

Sources: [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L122-L150)

## 下一步

现在你已经成功运行了 Himalaya，可以继续深入：

- **[编译与构建流程](https://github.com/1PercentSync/himalaya/blob/main/3-bian-yi-yu-gou-jian-liu-cheng)** — 详细了解 CMake 配置、多平台构建选项、发布版本优化
- **[四层架构设计](https://github.com/1PercentSync/himalaya/blob/main/7-si-ceng-jia-gou-she-ji)** — 深入理解 RHI → Framework → Passes → App 的分层设计哲学
- **[RHI层 - Vulkan抽象层](https://github.com/1PercentSync/himalaya/blob/main/8-rhiceng-vulkanchou-xiang-ceng)** — 学习 Vulkan 资源封装、命令录制、同步原语管理
- **[Render Graph资源管理](https://github.com/1PercentSync/himalaya/blob/main/12-render-graphzi-yuan-guan-li)** — 理解声明式资源管理、自动屏障插入、时域数据管理

如果你遇到构建问题，请参考 [第三方库依赖说明](https://github.com/1PercentSync/himalaya/blob/main/4-di-san-fang-ku-yi-lai-shuo-ming) 了解各依赖库的版本约束和故障排查方法。