渲染Pass层(Passes Layer)是Himalaya四层架构中的第三层，专注于具体渲染效果的实现。它建立在[RHI层 - Vulkan抽象层](https://github.com/1PercentSync/himalaya/blob/main/8-rhiceng-vulkanchou-xiang-ceng)提供的底层渲染能力之上，同时依赖[渲染框架层 - 资源与图管理](https://github.com/1PercentSync/himalaya/blob/main/9-xuan-ran-kuang-jia-ceng-zi-yuan-yu-tu-guan-li)管理的资源生命周期和Render Graph调度机制。本层的设计理念是**单一职责**——每个Pass封装一个完整、独立的渲染效果，通过标准化的接口与上层应用层交互。

## 核心设计理念

Pass层的架构设计遵循以下核心原则：

**声明式资源访问**：每个Pass在`record()`阶段声明其资源依赖(Read/ReadWrite/Write)，Render Graph据此自动计算图像布局转换和同步屏障。这种声明式方法消除了手动管理Vulkan Pipeline Barriers的复杂性，同时保证正确的执行顺序。

**三阶段生命周期管理**：所有Pass遵循统一的`setup()` → `record()` → `destroy()`生命周期。`setup()`负责管线创建和布局初始化；`record()`每帧调用，向Render Graph注册资源使用和执行回调；`destroy()`释放所有持有的Vulkan资源。

**MSAA感知设计**：几何渲染Pass(如DepthPrePass、ForwardPass)实现`on_sample_count_changed()`接口，支持动态MSAA级别切换。计算Pass和屏幕空间效果Pass(如GTAO、Contact Shadows)则始终处理1x分辨率数据，不参与多重采样。

**热重载支持**：每个Pass实现`rebuild_pipelines()`接口，支持运行时重新编译着色器。失败时自动保留旧管线，确保渲染不中断。

Sources: [depth_prepass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/depth_prepass.h#L22-L126), [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L22-L119), [render_graph.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_graph.h#L1-L504)

## Pass分类与职责

| Pass类型 | 实现类 | 核心职责 | MSAA支持 |
|---------|--------|----------|---------|
| **几何预渲染** | `DepthPrePass` | 深度+法线预填充，实现零Overdraw | 是 |
| **主渲染** | `ForwardPass` | 主前向光照渲染 | 是 |
| **阴影** | `ShadowPass` | CSM级联阴影深度渲染 | 否(固定1x) |
| **环境遮蔽** | `GTAOPass` | 地平线扫描AO计算 | 否 |
| **AO降噪** | `AOSpatialPass` | 5x5边缘感知双边模糊 | 否 |
| **AO时域** | `AOTemporalPass` | 时域累积与重投影 | 否 |
| **接触阴影** | `ContactShadowsPass` | 屏幕空间光线投射阴影 | 否 |
| **天空盒** | `SkyboxPass` | 环境立方体贴图背景 | 否(固定1x) |
| **后处理** | `TonemappingPass` | HDR色调映射到Swapchain | 否 |
| **光线追踪** | `ReferenceViewPass` | 路径追踪参考渲染 | 否 |

Sources: [passes目录结构](https://github.com/1PercentSync/himalaya/blob/main/passes/src), [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L1-L151)

## 几何渲染Pass详解

### 深度预渲染Pass

`DepthPrePass`是渲染管线的第一阶段，负责填充深度缓冲和G-Buffer法线信息。它采用**双管线策略**分别处理不透明(Opaque)和遮罩(Mask)材质：

不透明管线使用`depth_prepass.frag`，无`discard`指令，确保Early-Z硬件优化生效；遮罩管线使用`depth_prepass_masked.frag`，执行Alpha测试并丢弃透明像素。这种分离保证了不透明几何体获得最大化的Early-Z收益。

当MSAA启用时，Pass同时渲染到MSAA目标(法线、深度、粗糙度)，并通过Dynamic Rendering在单个Pass内完成Resolve操作：深度使用`MAX_BIT`解析(保留最近深度)，法线和粗糙度使用`AVERAGE`解析。

Sources: [depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L1-L332), [depth_prepass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/depth_prepass.h#L39-L50)

### 前向渲染Pass

`ForwardPass`是主光照Pass，渲染可见几何体到HDR颜色缓冲。它依赖DepthPrePass生成的深度缓冲，采用`VK_COMPARE_OP_EQUAL`深度测试且**关闭深度写入**，实现零Overdraw绘制。

Pass使用[材质系统](https://github.com/1PercentSync/himalaya/blob/main/13-cai-zhi-xi-tong-jia-gou)生成的实例化绘制组(MeshDrawGroup)进行批量提交，通过`draw_indexed`的实例化参数一次性绘制同网格的多个实例，显著减少CPU端Draw Call开销。

MSAA模式下，HDR颜色渲染到MSAA目标并通过`AVERAGE`解析到1x缓冲区；深度缓冲则直接从PrePass的MSAA深度读取，无需重复Resolve。

Sources: [forward_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/forward_pass.cpp#L1-L241), [forward_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/forward_pass.h#L38-L48)

### 级联阴影Pass

`ShadowPass`实现经典的Cascaded Shadow Maps(CSM)技术，将场景从主光源视角渲染到2D数组阴影贴图。它独立管理阴影贴图资源(非Render Graph托管)，每帧通过`import_image`引入图调度。

Pass支持动态级联数量配置(`cascade_count`)，但资源维度固定为`kMaxShadowCascades`层。类似深度预渲染，它也采用双管线策略：Opaque管线无片段着色器(纯深度输出)，Mask管线执行Alpha测试。

Reverse-Z深度配置下，斜率偏移(Slope Bias)取负值，将深度向远平面(0.0)推移以减少自阴影伪影。深度偏移钳位设置为`-0.005f`防止极端角度下的Peter Panning现象。

Sources: [shadow_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/shadow_pass.cpp#L1-L317), [shadow_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h#L1-L155)

## 屏幕空间效果Pass

### GTAO计算Pass

`GTAOPass`实现Ground-Truth Ambient Occlusion算法，通过结构化地平线搜索(Structured Horizon Search)计算每像素的漫反射环境遮蔽值。输出为RG8格式：`R`通道存储漫反射AO，`G`通道预留镜面遮蔽。

Pass采用计算着色器实现，工作组大小8x8，分发维度基于输出图像尺寸向上取整。AO参数(半径、方向数、步数等)通过Push Constants传递，帧索引用于时域抖动采样位置。

资源依赖声明：读取深度缓冲(Set 2 Binding 1)和法线缓冲(Set 2 Binding 2)，写入`ao_noisy`存储图像(Set 3 Push Descriptor Binding 0)。

Sources: [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L1-L177), [gtao_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/gtao_pass.h#L1-L102)

### AO降噪管线

AO降噪采用**双Pass级联**设计：空间降噪Pass执行5x5边缘感知双边滤波，时域降噪Pass执行重投影与帧间混合。

`AOSpatialPass`使用双边滤波保留几何边缘，输入`ao_noisy`采样图像，输出`ao_blurred`存储图像。滤波核权重基于深度差计算，避免跨表面模糊。

`AOTemporalPass`实现完整的时域抗闪烁流程：通过`depth_prev`和当前帧深度重投影历史UV坐标；执行三层拒绝(UV有效性、深度一致性、邻域钳制)；使用指数移动平均混合历史与当前帧。混合系数通过Push Constants动态调整，支持快速响应与稳定性平衡。

Sources: [ao_spatial_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_spatial_pass.cpp#L1-L165), [ao_temporal_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L1-L222)

### 接触阴影Pass

`ContactShadowsPass`实现屏幕空间接触阴影(Contact Shadows)，专门处理近距离高频阴影细节，与CSM形成互补。算法沿屏幕空间光线方向步进深度缓冲，检测遮挡关系。

Pass配置参数包括步数(`step_count`)、最大距离(`max_distance`)和基础厚度(`base_thickness`)，均通过Push Constants传递。光源方向从LightBuffer SSBO读取(Set 0 Binding 1)。

输出为R8掩码图像，供ForwardPass采样并与CSM阴影混合。

Sources: [contact_shadows_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/contact_shadows_pass.cpp#L1-L168), [contact_shadows_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/contact_shadows_pass.h#L1-L103)

## 后处理与效果Pass

### 天空盒Pass

`SkyboxPass`渲染环境立方体贴图作为场景背景。它采用全屏三角形绘制，在片段着色器中根据NDC坐标计算世界空间方向向量，采样立方体贴图。

深度测试配置为`VK_COMPARE_OP_GREATER_OR_EQUAL`，配合Reverse-Z(远平面=0.0)确保天空仅填充无几何体的像素。深度缓冲读取但不写入，颜色缓冲执行Load操作(继承ForwardPass输出)并Store最终结果。

Pass始终渲染到1x分辨率目标，与MSAA解析后的HDR颜色缓冲交互。

Sources: [skybox_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/skybox_pass.cpp#L1-L178), [skybox_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/skybox_pass.h#L1-L100)

### 色调映射Pass

`TonemappingPass`作为渲染管线最后阶段，将HDR颜色缓冲色调映射到Swapchain格式。它使用全屏顶点着色器(`fullscreen.vert`)，无顶点输入，从`gl_VertexIndex`生成NDC三角形。

Pass在`setup()`时接收Swapchain格式参数，将其烘焙到管线颜色附件格式中。资源声明读取`hdr_color`(片段着色器采样)，写入`swapchain`(颜色附件输出)。

当前实现采用简单直通或ACES色调映射，曝光控制通过GlobalUBO传递。

Sources: [tonemapping_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/tonemapping_pass.cpp#L1-L164), [tonemapping_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/tonemapping_pass.h#L1-L107)

## 光线追踪Pass

### 路径追踪参考视图

`ReferenceViewPass`实现基于Vulkan Ray Tracing Pipeline的路径追踪参考渲染器。它包含完整的RT着色器组：RayGen(`reference_view.rgen`)、ClosestHit(`closesthit.rchit`)、AnyHit(`anyhit.rahit`)、Miss(`miss.rmiss`)、ShadowMiss(`shadow_miss.rmiss`)。

Pass维护帧间累积状态(`sample_count_`)，实现渐进式收敛。每帧累加一个新样本并通过运行平均更新累积缓冲。`reset_accumulation()`接口支持手动重置(如相机移动后)。

Set 3 Push Descriptor包含四个绑定：累积缓冲(Storage Image)、辅助反照率(Storage Image)、辅助法线(Storage Image)、Sobol方向数(SSBO)。辅助图像在第一次反弹写入，供OIDN降噪器使用。

Sources: [reference_view_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/reference_view_pass.cpp#L1-L326), [reference_view_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/reference_view_pass.h#L1-L134)

## 帧上下文与数据流

所有Pass通过`FrameContext`结构接收每帧数据。该结构定义在[渲染框架层](https://github.com/1PercentSync/himalaya/blob/main/9-xuan-ran-kuang-jia-ceng-zi-yuan-yu-tu-guan-li)，包含：

**RG资源ID**：当前帧的Render Graph资源标识符(hdr_color、depth、ao_noisy等)，用于`record()`阶段的资源声明。

**场景数据引用**：网格数组、材质实例、剔除结果、实例化绘制组的非拥有引用。

**配置指针**：阴影配置、AO配置、接触阴影配置的只读指针。

**时域数据**：前一帧深度、AO历史、历史有效性标志，支撑时域降噪Pass。

Sources: [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L17-L151)

## 渲染目标格式规范

Pass层使用统一的渲染目标格式定义，集中声明于`render_constants.h`：

| 目标 | 格式 | 说明 |
|-----|------|------|
| 深度缓冲 | `VK_FORMAT_D32_SFLOAT` | Reverse-Z，无模板 |
| HDR颜色 | `VK_FORMAT_R16G16B16A16_SFLOAT` | 半精度浮点 |
| 法线缓冲 | `VK_FORMAT_A2B10G10R10_UNORM_PACK32` | 10-bit每通道 |
| 粗糙度 | `VK_FORMAT_R8_UNORM` | 单通道线性 |
| AO输出 | `VK_FORMAT_R8G8_UNORM` | RG8，漫反射+镜面 |

Sources: [render_constants.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/render_constants.h#L1-L29)

## 与上下层交互

```
┌─────────────────────────────────────────────────────────┐
│                    应用层 (Application)                  │
│     场景管理 → 相机控制 → 渲染器协调 → UI交互            │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              渲染Pass层 (Passes) ← You are here         │
│  DepthPrePass → ForwardPass → SkyboxPass → Tonemapping   │
│       ↓            ↓              ↓                        │
│  ShadowPass   GTAOPass → AOSpatialPass → AOTemporalPass  │
│       ↓            ↓              ↓                        │
│  ContactShadows   ReferenceViewPass (RT)                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│           渲染框架层 (Framework)                         │
│   RenderGraph调度 → 材质系统 → 实例化绘制 → IBL管理      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│              RHI层 (RHI)                                │
│   Vulkan资源封装 → 管线管理 → 命令缓冲 → 描述符管理      │
└─────────────────────────────────────────────────────────┘
```

Pass层作为架构承上启下的关键环节，向上为[应用层](https://github.com/1PercentSync/himalaya/blob/main/11-ying-yong-ceng-chang-jing-yu-jiao-hu)提供即插即用的渲染效果组件，向下通过Render Graph与[渲染框架层](https://github.com/1PercentSync/himalaya/blob/main/9-xuan-ran-kuang-jia-ceng-zi-yuan-yu-tu-guan-li)协同调度资源，最终调用[RHI层](https://github.com/1PercentSync/himalaya/blob/main/8-rhiceng-vulkanchou-xiang-ceng)的Vulkan抽象接口执行GPU命令。

## 后续阅读

- **[深度预渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/17-shen-du-yu-xuan-ran-pass)** - 深入了解Early-Z优化与双管线策略
- **[前向渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/18-qian-xiang-xuan-ran-pass)** - 主光照Pass的实例化绘制与材质集成
- **[级联阴影映射Pass](https://github.com/1PercentSync/himalaya/blob/main/20-ji-lian-yin-ying-ying-she-pass)** - CSM实现细节与阴影质量调优
- **[GTAO算法实现](https://github.com/1PercentSync/himalaya/blob/main/22-gtaosuan-fa-shi-xian)** - 地平线扫描算法的着色器实现
- **[路径追踪参考视图](https://github.com/1PercentSync/himalaya/blob/main/26-lu-jing-zhui-zong-can-kao-shi-tu)** - RT Pipeline与渐进式渲染