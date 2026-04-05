Himalaya渲染引擎采用基于**Render Graph**的Pass编排架构，将每一帧的渲染工作分解为多个独立的渲染Pass。每个Pass负责特定的渲染任务——从几何处理到光照计算，从阴影生成到后处理效果。Pass系统位于架构的**第二层(Passes Layer)**，建立在RHI抽象层和Framework资源管理层之上，为应用层提供可组合、可扩展的渲染效果实现。

这种设计将复杂的渲染管线拆解为独立的、可测试的单元，每个Pass通过声明式资源依赖与Render Graph交互，由Graph自动处理同步屏障和图像布局转换。Pass开发者只需关注算法实现本身，无需手动管理Vulkan的复杂同步语义。

Sources: [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L1-L119), [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L200)

## 核心设计原则

**单一职责与显式依赖**。每个Pass类封装一个完整的渲染阶段，包含初始化、每帧录制和资源清理三个生命周期阶段。Pass通过`record()`方法向Render Graph声明其资源读写依赖——包括颜色附件、深度缓冲、计算图像等——Graph据此计算Pass间的执行顺序和屏障插入点。这种声明式 approach 消除了手动同步错误，使并行执行成为可能。

```cpp
// Pass的典型接口模式：setup一次，record每帧，destroy清理
class ForwardPass {
    void setup(Context&, ResourceManager&, DescriptorManager&, 
               ShaderCompiler&, uint32_t sample_count);
    void record(RenderGraph&, const FrameContext&) const;
    void destroy() const;
};
```

**MSAA感知与动态适配**。图形Pass(如DepthPrePass、ForwardPass)通过`on_sample_count_changed()`接口支持运行时MSAA开关切换，计算Pass则始终处理单采样数据。MSAA缓冲在PrePass阶段生成，解析为单采样后供屏幕空间效果使用，最终在Forward Pass中重新启用多采样渲染。

**热重载友好**。所有Pass实现`rebuild_pipelines()`接口，支持开发期着色器热重载。该设计配合文件监控可实现"保存即见"的迭代体验，无需重启应用即可观察着色器修改效果。

Sources: [depth_prepass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/depth_prepass.h#L1-L126), [gtao_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/gtao_pass.h#L1-L102)

## 架构分层与模块关系

Pass系统在整个渲染架构中处于承上启下的位置：

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Application (Renderer, SceneLoader, UI)        │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Passes (本文档)                                │
│  ├── 几何Pass: DepthPrePass, ForwardPass                │
│  ├── 阴影Pass: ShadowPass, ContactShadowsPass            │
│  ├── AO Pass: GTAOPass, AOSpatialPass, AOTemporalPass   │
│  ├── 后处理: TonemappingPass, SkyboxPass                │
│  └── 光线追踪: ReferenceViewPass                        │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Framework (RenderGraph, FrameContext,资源管理) │
├─────────────────────────────────────────────────────────┤
│  Layer 0: RHI (Vulkan Context, Pipeline, CommandBuffer) │
└─────────────────────────────────────────────────────────┘
```

Render Graph作为核心编排器，每帧执行`clear() → import resources → add passes → compile() → execute()`的构建循环。Pass仅需在`record()`中声明资源依赖并提交执行回调，Graph负责：
- 计算图像布局转换路径
- 在Pass边界插入`vkCmdPipelineBarrier`
- 管理时域资源的双缓冲交换

FrameContext作为每帧渲染的"上下文合同"，携带RG资源ID、场景数据和渲染配置，由Renderer填充后传递给各Pass的`record()`方法。

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L1-L151), [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L200-L399)

## Pass分类与功能矩阵

当前Milestone 1实现的Pass可按功能域划分为四大类别：

| 类别 | Pass名称 | 管线类型 | MSAA支持 | 核心功能 |
|------|----------|----------|----------|----------|
| **几何与基础** | DepthPrePass | 图形 | ✓ | 深度预渲染+法线生成，为Forward Pass实现零overdraw |
| | ForwardPass | 图形 | ✓ | 主前向光照，PBR材质+IBL+阴影集成 |
| | SkyboxPass | 图形 | ✗ | 全屏天空盒，深度剔除只在无几何处填充 |
| **阴影系统** | ShadowPass | 图形 | ✗ | CSM级联阴影图渲染，2D Array纹理 |
| | ContactShadowsPass | 计算 | ✗ | 屏幕空间接触阴影，填补CSM近处精度不足 |
| **环境光遮蔽** | GTAOPass | 计算 | ✗ | Ground-Truth AO，水平地平线搜索 |
| | AOSpatialPass | 计算 | ✗ | 5x5边缘感知双边滤波，空间降噪 |
| | AOTemporalPass | 计算 | ✗ | 重投影时域滤波，历史帧混合 |
| **后处理** | TonemappingPass | 图形 | ✗ | ACES色调映射，HDR→LDR转换 |
| **光线追踪** | ReferenceViewPass | 光线追踪 | N/A | 路径追踪参考视图，渐进式收敛 |

Sources: [m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L1-L200), [forward_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/forward_pass.cpp#L1-L200)

## 典型帧流程示例

以光栅化管线为例，各Pass的执行顺序与数据流转如下：

```
[DepthPrePass] ──► Depth(MSAA) ──► Resolve ──► Depth(1x)
        │                              │
        └──────► Normal(MSAA) ──► Resolve ──► Normal(1x)
                                          │
[GTAO Pass] ◄─────────────────────────────┘
        │
        ▼
[AO Spatial] ──► [AO Temporal] ──► AO Filtered
                                          │
[ShadowPass] ──► Shadow Map 2D Array ◄────┤
        │                                  │
        ▼                                  ▼
[ContactShadows] ──► Contact Mask ◄───────┤
        │                                  │
        └──────────────────────────────────┘
                    │
                    ▼
[ForwardPass] ◄────┘ (读取AO+Shadow+ContactShadow)
        │
        ▼
[TonemappingPass] ──► Swapchain
```

MSAA处理遵循特定策略：Depth/Normal PrePass生成多采样缓冲，但所有屏幕空间效果(AO、Contact Shadows)在**解析后的单采样**缓冲上操作。这种设计在保证几何渲染精度的同时，避免了在MSAA缓冲上执行复杂采样操作的开销。

Sources: [m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L1-L50), [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L200-L300)

## Pass实现模式

所有Pass遵循统一的实现模式，确保接口一致性和可维护性：

**生命周期三阶段**：
1. **setup()** - 一次性初始化：编译着色器、创建管线、存储服务指针(Context/RM/DM/SC)
2. **record()** - 每帧调用：声明RG资源依赖、提交执行lambda
3. **destroy()** - 清理：销毁管线、释放描述符布局

**资源声明模式**：
```cpp
void SomePass::record(RenderGraph& rg, const FrameContext& ctx) const {
    std::vector<RGResourceUsage> resources;
    // 写操作声明
    resources.push_back({ctx.output_image, RGAccessType::Write, 
                         RGStage::ColorAttachment});
    // 读操作声明  
    resources.push_back({ctx.input_image, RGAccessType::Read,
                         RGStage::Fragment});
                         
    rg.add_pass("PassName", resources, execute_callback);
}
```

**服务指针存储**：Pass在`setup()`中存储RHI基础设施的引用，在`record()`的lambda中通过`this`访问。这种设计避免了将大型服务对象复制到FrameContext，同时确保线程安全(所有状态修改仅在setup/destroy中进行)。

Sources: [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L80-L119), [tonemapping_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/tonemapping_pass.h#L80-L107)

## 与Render Graph的协作机制

Pass与Render Graph的交互通过**资源声明**和**执行回调**两个核心机制实现：

**资源声明**使用`RGResourceUsage`三元组描述每项资源的访问模式：
- `RGResourceId` - 资源标识符(由import_image/use_managed_image返回)
- `RGAccessType` - 访问类型(Read/Write/ReadWrite)
- `RGStage` - 管线阶段(Compute/Fragment/ColorAttachment/DepthAttachment等)

Graph在`compile()`阶段分析所有Pass的资源声明，构建资源状态机并计算所需的`VkImageMemoryBarrier`。执行阶段`execute()`按注册顺序调用各Pass的回调，在Pass边界自动插入屏障。

**时域资源管理**通过`create_managed_image(temporal=true)`实现双缓冲。Graph自动处理current/history交换，Pass通过`get_history_image()`获取历史帧数据，通过`is_history_valid()`判断历史有效性(首帧或尺寸变化后返回false)。

Sources: [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L200), [ao_temporal_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/ao_temporal_pass.h#L1-L111)

## 扩展与定制指南

添加新Pass需遵循以下步骤：

1. **创建头文件**于`passes/include/himalaya/passes/`，继承标准接口模式
2. **实现源文件**于`passes/src/`，包含着色器编译、管线创建和录制逻辑
3. **注册到Renderer**：在`Renderer`类中添加成员，于`init()`调用`setup()`，于`render()`调用`record()`
4. **编写着色器**于`shaders/`目录，通过`#include "common/bindings.glsl"`确保绑定一致性

**关键设计决策**：
- 图形Pass需考虑MSAA支持，计算Pass固定处理单采样
- 屏幕空间效果优先使用Compute Shader(写入storage image)
- 需直接写入SRGB swapchain的Pass使用全屏Fragment Shader(SRGB format不支持STORAGE_BIT)
- 热重载支持：在`rebuild_pipelines()`中重新编译着色器并重建管线

Sources: [m1-interfaces.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-interfaces.md#L1-L200), [forward_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/forward_pass.cpp#L1-L100)

## 下一步学习路径

理解Pass系统的完整上下文，建议按以下顺序深入：

- **[四层架构设计](https://github.com/1PercentSync/himalaya/blob/main/7-si-ceng-jia-gou-she-ji)** - 理解Pass在整体架构中的定位
- **[Render Graph资源管理](https://github.com/1PercentSync/himalaya/blob/main/12-render-graphzi-yuan-guan-li)** - 深入资源依赖声明与屏障生成机制
- **[深度预渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/17-shen-du-yu-xuan-ran-pass)** - 学习MSAA感知的图形Pass实现细节
- **[GTAO算法实现](https://github.com/1PercentSync/himalaya/blob/main/22-gtaosuan-fa-shi-xian)** - 研究计算Pass与屏幕空间效果实现
- **[时域降噪Pass](https://github.com/1PercentSync/himalaya/blob/main/23-shi-yu-jiang-zao-pass)** - 理解时域资源管理与历史帧复用