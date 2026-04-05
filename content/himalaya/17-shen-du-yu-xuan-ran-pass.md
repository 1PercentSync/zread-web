深度预渲染Pass（DepthPrePass）是Himalaya渲染管线的几何基础阶段，负责在正式光照计算之前填充深度、法线和粗糙度缓冲区。这一设计通过**Early-Z剔除**消除前向渲染Pass的overdraw，同时产生后续屏幕空间效果（GTAO、接触阴影）所需的法线与深度数据。Pass采用**双管线分离策略**处理不透明与透明遮罩几何体，在MSAA模式下通过Dynamic Rendering的原生resolve功能将多采样数据降采样到单采样目标。

Sources: [passes/include/himalaya/passes/depth_prepass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/depth_prepass.h#L1-L126)

## 核心设计目标

深度预渲染Pass服务于三个相互关联的渲染需求：**零overdraw保证**、**屏幕空间效果数据供给**、以及**多采样抗锯齿兼容性**。在典型的延迟渲染架构中，这些目标通过G-Buffer实现，但Himalaya采用前向渲染管线，因此需要在主光照Pass之前执行一个轻量级的几何Pass来提取必要信息。

零overdraw的实现依赖于顶点着色器中`invariant gl_Position`修饰符——该GLSL特性保证相同数学运算在不同着色器中产生**位级一致的深度值** [shaders/depth_prepass.vert](https://github.com/1PercentSync/himalaya/blob/main/shaders/depth_prepass.vert#L35)。这使得前向渲染Pass可以使用`VK_COMPARE_OP_EQUAL`深度测试，仅绘制与预渲染Pass深度精确匹配的片段，完全剔除被遮挡的几何体。

法线缓冲区的输出并非原始顶点法线，而是经过法线贴图采样和TBN矩阵变换后的**世界空间着色法线** [shaders/depth_prepass.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/depth_prepass.frag#L34-L36)。这种设计让后续的GTAO等效果能够基于真实的表面微几何进行计算，而非粗糙的顶点插值。粗糙度输出则直接来自金属-粗糙度纹理的G通道，乘以材质系数后写入独立缓冲区，供后续帧的时域降噪使用。

## 双管线分离架构

Pass维护两条独立的图形管线以优化GPU Early-Z硬件行为。Opaque管线使用[depth_prepass.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/depth_prepass.frag#L1-L43)，其关键特性是**无discard语句**——驱动程序可据此启用层次Z剔除（Hi-Z）和Early-Z测试，在片元着色器执行前就剔除不可见像素。Mask管线则使用[depth_prepass_masked.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/depth_prepass_masked.frag#L1-L53)，包含基于alpha_cutoff的discard逻辑，用于处理植被、栅栏等需要像素级透明度测试的材质。

两条管线共享相同的顶点着色器和管线布局，仅在片元着色器阶段分叉。这种设计让Opaque批次能够享受完整的Early-Z优化，而Mask批次虽因discard丧失部分优化，但仍能从预填充的深度缓冲区中受益——被Opaque几何遮挡的Mask片元会在深度测试阶段被剔除，无需进入 costly 的alpha测试和法线贴图采样。

渲染顺序严格执行**Opaque优先、Mask次之**的策略 [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L248-L261)。这种排序最大化深度缓冲区的早期填充，为后续批次提供尽可能多的遮挡信息。

## MSAA与Dynamic Rendering集成

现代渲染器需要支持多采样抗锯齿以处理几何边缘锯齿，但屏幕空间效果（AO、阴影）通常在单采样分辨率下计算。深度预渲染Pass通过Vulkan Dynamic Rendering的原生resolve功能优雅处理这一矛盾，避免额外的显式resolve Pass。

在MSAA模式下，Pass向Render Graph声明两组资源：MSAA目标（读/写访问）和resolve目标（仅写访问） [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L287-L310)。`VkRenderingAttachmentInfo`结构配置为在渲染通道结束时自动执行resolve操作，其中深度使用`VK_RESOLVE_MODE_MAX_BIT`（保留最近深度），法线和粗糙度使用`VK_RESOLVE_MODE_AVERAGE_BIT`（子采样平均） [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L105-L140)。

MSAA resolve的数学正确性依赖于法线编码方案的选择。R10G10B10A2 UNORM格式将[-1,1]的法线线性映射到[0,1] [shaders/common/normal.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/normal.glsl#L45-L47)，子采样的平均操作在编码空间保持线性，解码后只需normalize即可恢复单位向量。相比之下，非线性编码（如octahedral编码）在resolve后会产生偏差。

非MSAA模式下，Pass直接渲染到单采样目标，resolve相关字段被省略，Render Graph资源声明简化为3个读/写附件 [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L311-L329)。

## Reverse-Z深度约定

Pass采用Reverse-Z深度映射约定：近平面depth=1.0，远平面depth=0.0。这一选择配合`VK_COMPARE_OP_GREATER`深度测试 [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L237)，在浮点深度缓冲区的精度分布上获得显著优势——浮点数的指数分布使更多精度位集中在near plane附近，而Reverse-Z将这一优势扩展到远平面区域，对大型开放世界场景尤为重要。

清除值设置为`{0.0f, 0}` [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L121-L122)，对应远平面深度。这确保未渲染区域（如天空）在深度测试中被正确处理为最远距离。

## 顶点与实例数据处理

顶点着色器接收标准化顶点布局：位置、法线、UV0、切线、UV1，与框架层的`framework::Vertex`结构严格对齐 [shaders/depth_prepass.vert](https://github.com/1PercentSync/himalaya/blob/main/shaders/depth_prepass.vert#L16-L20)。实例数据通过SSBO索引访问，使用`gl_InstanceIndex`从全局InstanceBuffer获取模型矩阵和法线矩阵。

法线矩阵在CPU端预计算为`transpose(inverse(mat3(model)))` [shaders/common/bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L33-L39)，避免在顶点着色器中执行每顶点的矩阵求逆。这种预计算对非均匀缩放模型尤为重要，能正确处理法线从切线空间到世界空间的变换。

TBN矩阵构建时保留切线w分量的手性信息 [shaders/depth_prepass.vert](https://github.com/1PercentSync/himalaya/blob/main/shaders/depth_prepass.vert#L50)，用于确定副切线方向（B = cross(N, T) * w），支持镜像UV布局的法线贴图正确采样。

## 管线生命周期管理

Pass的管线创建采用**先编译后替换**策略 [passes/src/depth_prepass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/depth_prepass.cpp#L54-L78)：所有着色器（顶点、Opaque片元、Mask片元）先编译为SPIR-V，任一失败则保留旧管线；全部成功后销毁旧管线并创建新管线。这一设计支持运行时的着色器重载（通过`rebuild_pipelines()` API）而不破坏当前渲染状态。

MSAA样本数变化触发`on_sample_count_changed()`回调，该函数更新内部状态并重建管线 [passes/include/himalaya/passes/depth_prepass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/depth_prepass.h#L54-L62)。调用者需保证GPU空闲（通过`vkQueueWaitIdle`），因为管线销毁和创建非线程安全。

## 在帧流程中的位置

根据Milestone 1帧流程设计，深度预渲染Pass位于阴影Pass之后、屏幕空间效果之前 [docs/milestone-1/m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L29-L45)。其输出（深度、法线、粗糙度）被后续的GTAO Pass、接触阴影Pass、以及主Forward Pass消费。

对于MSAA配置，Pass之后立即跟随隐含的resolve操作（通过Dynamic Rendering），然后屏幕空间效果在单采样目标上执行，最终Forward Pass再次以MSAA模式渲染到多采样HDR颜色缓冲 [docs/milestone-1/m1-frame-flow.md](https://github.com/1PercentSync/himalaya/blob/main/docs/milestone-1/m1-frame-flow.md#L19-L27)。

---

## 下一步阅读

理解深度预渲染Pass的数据产出后，建议继续阅读：

- **[前向渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/18-qian-xiang-xuan-ran-pass)** — 了解如何利用预填充的深度缓冲区实现零overdraw光照计算
- **[GTAO算法实现](https://github.com/1PercentSync/himalaya/blob/main/22-gtaosuan-fa-shi-xian)** — 探索深度与法线数据如何驱动屏幕空间环境光遮蔽
- **[Render Graph资源管理](https://github.com/1PercentSync/himalaya/blob/main/12-render-graphzi-yuan-guan-li)** — 深入理解Pass间的数据依赖与同步机制