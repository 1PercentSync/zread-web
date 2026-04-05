Himalaya 渲染器采用严格分层的架构设计，将渲染系统的复杂度按职责垂直划分为四个层次。这种分层模式遵循**严格单向依赖**原则：上层依赖下层，下层不知道上层的存在；同层之间通过明确定义的接口间接通信，而非直接引用。

这种架构的核心价值在于**渐进式开发能力**——每个里程碑可以独立添加新的 Pass，无需修改现有代码；同时支持**运行时模块化**——通过配置开关即可启用或禁用特定渲染效果，系统会自动调整资源依赖和同步屏障。

## 四层架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        Layer 3: 应用层                           │
│   Application, SceneLoader, CameraController, DebugUI            │
│   职责: 场景加载、相机控制、用户交互、填充渲染列表                   │
├─────────────────────────────────────────────────────────────────┤
│                        Layer 2: 渲染Pass层                       │
│   ForwardPass, ShadowPass, GTAOPass, SkyboxPass...             │
│   职责: 实现具体渲染效果，声明输入输出，注册到Render Graph           │
├─────────────────────────────────────────────────────────────────┤
│                       Layer 1: 渲染框架层                        │
│   RenderGraph, MaterialSystem, SceneRenderData, FrameContext     │
│   职责: 通用渲染框架、资源编排、材质管理、场景数据定义               │
├─────────────────────────────────────────────────────────────────┤
│                       Layer 0: Vulkan抽象层 (RHI)                │
│   Context, ResourceManager, DescriptorManager, Pipeline          │
│   职责: 封装Vulkan底层API，提供资源创建和命令录制接口                │
└─────────────────────────────────────────────────────────────────┘
```

架构数据流遵循**自顶向下**的单向传递模式：应用层构建场景数据 → 框架层通过Render Graph调度 → Pass层执行具体渲染 → RHI层转换为Vulkan命令。这种设计消除了循环依赖，使得每一层都可以独立测试和演进。

Sources: [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L90-L103)

## Layer 0: Vulkan 抽象层 (RHI)

RHI（Rendering Hardware Interface）层是架构的最底层，承担**Vulkan API封装**的职责。它向上层提供简洁的资源创建和操作接口，同时完全屏蔽了Vulkan的复杂度。该层的设计原则是**不包含任何渲染逻辑**——它不知道什么是Shadow Map或SSAO，只知道如何创建Image、创建Pipeline、录制Command Buffer。

**核心组件**包括：Context管理Vulkan实例、设备和队列；ResourceManager负责Buffer、Image、Sampler的资源池管理；DescriptorManager实现Bindless描述符系统；Pipeline封装图形和计算管线的创建与缓存；ShaderCompiler提供运行时GLSL到SPIR-V的编译能力。

**关键抽象设计**体现在资源句柄系统。所有GPU资源通过轻量级句柄访问，而非直接暴露Vulkan句柄：

```cpp
struct ImageHandle {
    uint32_t index = UINT32_MAX;      // 资源池槽位索引
    uint32_t generation = 0;          // 世代计数器，用于检测use-after-free
    [[nodiscard]] bool valid() const { return index != UINT32_MAX; }
};
```

这种设计配合**延迟销毁队列（DeletionQueue）**机制，确保GPU资源在不再被引用时才被安全回收。每帧结束时，当前帧的删除队列会被执行，释放该帧期间标记为待删除的资源。

Sources: [types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L23-L34), [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L64-L81)

**双缓冲同步架构**是RHI的另一核心特征。Context维护`kMaxFramesInFlight`（默认为2）个FrameData结构，每个包含独立的Command Pool、Command Buffer、Fence和Semaphore。这使得CPU可以录制第N+1帧的同时，GPU执行第N帧，实现完全的CPU-GPU并行：

```cpp
constexpr uint32_t kMaxFramesInFlight = 2;
struct FrameData {
    VkCommandPool command_pool;
    VkCommandBuffer command_buffer;
    VkFence render_fence;                    // GPU完成信号
    VkSemaphore image_available_semaphore;   // 获取交换链图像信号
    DeletionQueue deletion_queue;
};
std::array<FrameData, kMaxFramesInFlight> frames;
```

Sources: [context.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/context.h#L41-L103)

## Layer 1: 渲染框架层 (Framework)

Framework层提供**渲染相关的通用基础设施**，不涉及具体的渲染效果实现。它定义了"渲染一帧"的骨架——接收渲染列表，经由Render Graph调度各Pass，输出最终图像。具体有哪些Pass、每个Pass做什么，由上层定义。

**Render Graph**是该层的核心组件，承担**声明式帧渲染管理**职责。每个Pass声明自己读取和写入哪些资源，系统自动计算执行顺序、插入同步屏障（Barrier）、管理资源生命周期。这种设计将开发者从手动管理`VkImageMemoryBarrier`的繁琐工作中解放出来。

Render Graph的资源管理分为三种模式：

| 管理方式 | 适用场景 | 典型资源 |
|---------|---------|---------|
| **RG Managed** | 需要跟随屏幕分辨率resize | Depth/Normal/HDR Color buffer、AO texture |
| **Pass自管理** | 固定尺寸的特殊资源 | Shadow map array、IBL Cubemap |
| **RG Temporal** | 需要历史帧数据的时域资源 | AO history buffer、TAA history |

RG Managed资源的核心价值在于**resize自动重建**。当窗口大小变化时，所有Relative模式的托管图像会自动销毁旧资源并创建新资源，保持正确的分辨率比例。

Sources: [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L24-L36), [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L26-L88)

**FrameContext**是连接各层的数据枢纽。每帧由Renderer填充，然后传递给所有Pass的`record()`方法。它包含RG资源ID（当前帧的交换链图像、HDR颜色缓冲等）、场景数据引用（mesh实例、剔除结果、绘制分组）、以及渲染配置参数（阴影配置、AO配置等）：

```cpp
struct FrameContext {
    // RG资源ID（每帧变化）
    RGResourceId swapchain, hdr_color, depth;
    RGResourceId shadow_map, ao_filtered, ao_history;
    
    // 场景数据（非拥有引用）
    std::span<const Mesh> meshes;
    std::span<const MeshInstance> mesh_instances;
    const CullResult* cull_result;
    
    // 渲染配置
    const RenderFeatures* features;
    const ShadowConfig* shadow_config;
    const AOConfig* ao_config;
};
```

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L32-L149)

**材质系统**采用三层架构：材质模板/着色模型定义一种着色方式（标准PBR、卡通渲染等）；材质实例基于模板设置具体参数（albedo贴图、roughness值）；Shader变体管理编译时开关的编译和缓存。当前实现仅支持标准PBR，但架构已预留扩展空间。

Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L20-L80)

**场景数据层**定义了应用层与渲染层之间的契约。`SceneRenderData`是应用层填充的渲染视图，包含网格实例数组、光源数组和相机参数；`CullResult`是剔除系统输出的可见性索引列表，不修改原始场景数据。这种分离支持多视图渲染（CSM级联、反射探针、VR双眼）和编辑器工具集成。

Sources: [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L93-L116)

## Layer 2: 渲染Pass层 (Passes)

Pass层实现**每一个具体的渲染Pass**。每个Pass是独立的自包含模块，声明自己的输入输出，注册到Render Graph。添加或移除一个Pass不需要修改其他Pass的代码——这是渐进式开发模式的核心支撑。

**标准化接口**定义了所有Pass的共同契约：

| 方法 | 职责 | 调用时机 |
|-----|------|---------|
| `setup()` | 创建Pipeline、固定资源，存储服务指针 | 初始化时一次 |
| `record()` | 声明RG资源依赖，提供执行回调 | 每帧 |
| `on_sample_count_changed()` | MSAA切换时重建Pipeline | 运行时配置变更 |
| `on_resolution_changed()` | 分辨率变化时重建资源 | 窗口resize |
| `rebuild_pipelines()` | 热重载着色器 | 开发者请求 |
| `destroy()` | 释放所有资源 | 应用退出 |

**ForwardPass**作为最典型的Pass示例，展示了Layer 2的设计模式。它在`setup()`中接收RHI服务指针并创建Pipeline；在`record()`中接收Render Graph和Frame Context，注册资源依赖并录制命令。ForwardPass是MSAA感知的，其Pipeline的`rasterizationSamples`会在MSAA配置变更时动态重建。

Sources: [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L35-L118)

**ShadowPass**展示了Pass自管理资源的模式。由于阴影贴图是固定尺寸（2048×2048）且不随屏幕resize，它选择自行创建和管理shadow map资源，每帧通过`import_image()`将其导入Render Graph以获得barrier自动化。这种设计避免了RG Managed带来的所有权分裂问题。

Sources: [shadow_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h#L45-L154)

**Pass间的解耦通信**通过资源声明而非直接引用实现。例如GTAOPass不持有DepthPrePass的引用，只声明"我需要DepthBuffer输入"；Render Graph根据这些声明自动连接资源流。当DepthPrePass被禁用时，GTAOPass可以回退到其他深度来源或优雅禁用，无需修改代码。

## Layer 3: 应用层 (App)

应用层是架构的最顶层，承担**场景管理、资产加载、用户交互**的职责。它填充渲染列表（mesh实例、光源、相机参数），然后调用Framework层的"渲染一帧"接口。应用层不关心渲染器内部有哪些Pass、如何调度。

**Application**类是顶层协调者，管理整个子系统的生命周期。它拥有RHI基础设施（Context、Swapchain、ResourceManager）、Framework服务（ImGuiBackend、Camera）、以及应用模块（SceneLoader、DebugUI、Renderer）。`run()`方法实现主帧循环：poll事件 → begin_frame → update → render → end_frame。

Sources: [application.h](https://github.com/1PercentSync/himalaya/blob/main/app/include/himalaya/app/application.h#L30-L325)

**Renderer**作为应用层与Framework层的桥梁，承担**帧数据准备和Render Graph构建**的职责。每帧它执行以下流程：填充Common GPU数据（相机矩阵、光源数组等）→ 执行视锥剔除 → 构建Instancing绘制分组 → 创建RG托管资源 → 调度所有Pass的`record()` → 编译并执行Render Graph。

Sources: [renderer.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer.cpp)

**数据分层设计**在应用层得到最终体现。GPU数据按更新频率分为三层管理：全局数据（相机矩阵、光源、曝光值）每帧更新到全局Uniform Buffer；材质数据（PBR参数、纹理索引）加载时一次上传到SSBO；Per-draw数据（模型矩阵、材质索引）通过Push Constant或Instance Buffer每次绘制传递。这种分层最小化了GPU数据传输开销。

Sources: [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L203-L212)

## 架构约束与边界

四层架构通过一组**严格的架构约束**来维持其设计完整性：

| 约束 | 目的 | 例外情况 |
|-----|------|---------|
| 上层不接触Vulkan类型 | 保护Layer 0实现自由度 | Render Graph使用VkImageLayout进行barrier管理；ImGui Backend直接使用Vulkan类型 |
| Pass间只通过资源声明通信 | 保障Pass可插拔性 | 无例外，这是核心设计原则 |
| 渲染列表帧内不可变 | 支持多视图复用、数据安全 | 剔除结果是独立索引列表 |
| 配置参数单向传递 | 数据流清晰可追踪 | 应用层 → 配置结构体 → Pass读取 |
| Temporal数据归属Pass | 模块启用禁用的干净性 | 由RG temporal机制统一管理 |

**跨层依赖关系**严格遵循单向原则：Application依赖所有下层；Renderer依赖Framework和RHI；Pass通过标准接口与Framework交互；RHI完全不感知上层存在。这种设计使得每一层都可以独立演进——例如更换RHI实现（如迁移到Metal或DX12）不会影响到Pass层的代码。

Sources: [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L172-L195)

## 阅读路径推荐

理解了四层架构设计后，建议按以下顺序深入各层细节：

1. **[RHI层 - Vulkan抽象层](https://github.com/1PercentSync/himalaya/blob/main/8-rhiceng-vulkanchou-xiang-ceng)** - 了解资源句柄、命令缓冲、Bindless描述符的具体实现
2. **[渲染框架层 - 资源与图管理](https://github.com/1PercentSync/himalaya/blob/main/9-xuan-ran-kuang-jia-ceng-zi-yuan-yu-tu-guan-li)** - 深入Render Graph的工作机制和托管资源系统
3. **[渲染Pass层 - 效果实现](https://github.com/1PercentSync/himalaya/blob/main/10-xuan-ran-passceng-xiao-guo-shi-xian)** - 学习如何编写新的渲染Pass
4. **[应用层 - 场景与交互](https://github.com/1PercentSync/himalaya/blob/main/11-ying-yong-ceng-chang-jing-yu-jiao-hu)** - 理解场景加载、相机控制、帧循环协调

对于希望立即实践的开发人员，推荐从**[Pass系统概述](https://github.com/1PercentSync/himalaya/blob/main/16-passxi-tong-gai-shu)**开始，了解已有Pass的组织方式，然后参考具体Pass实现（如[深度预渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/17-shen-du-yu-xuan-ran-pass)或[前向渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/18-qian-xiang-xuan-ran-pass)）作为编写新Pass的模板。