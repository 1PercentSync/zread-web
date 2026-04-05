本文档详述Himalaya引擎光线追踪渲染管线中的着色器组架构与实现。路径追踪参考视图（Reference View Pass）采用完整的Vulkan RT管线，包含5个专用着色器阶段和共享工具库，实现了渐进式路径追踪与OIDN降噪器的数据生成。

## 管线架构概览

Himalaya的RT管线采用**Mode A架构**：Ray Generation着色器负责路径迭代与累加逻辑，Closest-Hit着色器承担全部表面着色计算。这种设计分离了路径采样策略与BRDF实现，使得材质系统可以独立演进而不影响路径积分器。

管线包含4个Shader Binding Table（SBT）组：Raygen组（生成主光线）、环境Miss组（IBL采样）、阴影Miss组（可见性标记）、命中组（Closest-Hit + 可选Any-Hit）。RHI层通过`create_rt_pipeline`函数管理管线的创建与SBT构造，确保着色器句柄正确布局在GPU可访问的绑定表中。

Sources: [rt_pipeline.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/rt_pipeline.cpp#L1-L197)

## 着色器阶段详解

### Ray Generation着色器 (reference_view.rgen)

作为RT管线的入口点，Raygen着色器实现完整的路径追踪循环。每个像素独立执行，通过`traceRayEXT`发起光线遍历。核心功能包括：

**主光线生成**：利用逆相机矩阵将像素坐标转换为世界空间光线方向，采用Sobol序列维度0-1实现子像素抖动抗锯齿。Reverse-Z投影配合`gl_LaunchIDEXT`实现正确的射线方向计算。

**路径积分循环**：支持可配置的最大反弹次数（`max_bounces`），每轮迭代执行Russian Roulette路径终止（从第2次反弹开始）。路径吞吐量通过各反弹贡献的乘积累积，当吞吐量低于阈值时提前终止以节省计算资源。

**时域累加**：实现渐进式渲染的运行平均算法。首帧（`sample_count == 0`）直接写入，后续帧执行增量混合：`result = mix(old, new, 1/(n+1))`。这种设计允许相机静止时无限累积样本以收敛到参考图像。

**Push Constants布局**：20字节对齐结构传递`max_bounces`、`sample_count`、`frame_seed`、`blue_noise_index`和`max_clamp`（萤火虫钳制阈值），避免每帧Descriptor Set更新开销。

Sources: [reference_view.rgen](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/reference_view.rgen#L1-L144)

### Closest-Hit着色器 (closesthit.rchit)

这是管线的核心计算阶段，执行完整的PBR表面着色。通过`gl_InstanceCustomIndexEXT + gl_GeometryIndexEXT`索引`GeometryInfo`缓冲区，获取顶点/索引缓冲区设备地址实现零拷贝几何访问。

**顶点属性插值**：使用`interpolate_hit`工具函数从`VertexBuffer`引用中读取三角形顶点，计算重心坐标插值后的位置、法线、切线、UV坐标和真实的面法线（通过三角形边叉积计算）。所有属性在对象空间插值后，通过`gl_ObjectToWorldEXT`和`gl_WorldToObjectEXT`变换矩阵转换到世界空间。

**法线映射与一致性修正**：从切线空间法线贴图采样后，通过`get_shading_normal`重建扰动法线，再使用`ensure_normal_consistency`确保扰动法线与几何法线处于同一半球，防止光线追踪中的漏光伪影。双面材质通过`dot(N_face, ray_dir)`检测并翻转法线。

**多Lobe BRDF采样**：实现漫反射（Lambertian）与镜面（GGX）的混合采样。使用Fresnel反射亮度计算镜面选择概率`p_spec`，避免零概率导致的除零错误。镜面Lobe采用Heitz 2018的GGX VNDF重要性采样，漫反射Lobe使用余弦加权半球采样。

**Next Event Estimation**：对每盏方向光发射阴影光线（`gl_RayFlagsTerminateOnFirstHitEXT | gl_RayFlagsSkipClosestHitShaderEXT`），通过独立的ShadowPayload获取可见性，结合BRDF计算直接光照贡献。阴影Miss着色器在光线无遮挡时将`visible`标记设为1。

**OIDN辅助数据输出**：仅在第0次反弹时向Set 3的binding 1-2写入反照率（diffuse_color）与世界空间法线（N_shading），为Intel Open Image Denoise提供降噪所需的特征缓冲区。

Sources: [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L1-L227)

### Any-Hit着色器 (anyhit.rahit)

专门处理非不透明几何体的可见性判定。通过`BLASGeometry::opaque`标志在硬件层面控制：不透明几何体设置`VK_GEOMETRY_OPAQUE_BIT_KHR`直接跳过Any-Hit调用，半透明几何体则进入此着色器执行Alpha测试。

**Mask模式（alpha_mode == 1）**：硬截断测试，当`texel_alpha < alpha_cutoff`时调用`ignoreIntersectionEXT`忽略当前交点，允许光线继续遍历寻找后续几何体。

**Blend模式（alpha_mode == 2）**：随机透明度实现有序无关的alpha混合。基于像素坐标、帧种子、图元ID和几何索引计算PCG哈希种子，生成均匀随机数与纹理Alpha比较。这种方法避免了深度排序的开销，同时保持无偏的透明度效果。

为优化性能，Any-Hit仅执行轻量级的UV插值（不计算完整的HitAttributes），直接从顶点缓冲区读取并插值UV0坐标用于Alpha纹理采样。

Sources: [anyhit.rahit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/anyhit.rahit#L1-L83)

### Miss着色器组

**环境Miss（miss.rmiss）**：当主光线未命中任何几何体时触发，采样IBL立方体贴图。应用`global.ibl_rotation_sin/cos`实现环境旋转，结合`global.ibl_intensity`调整亮度。通过`payload.hit_distance = -1.0`向Raygen信号路径终止。

**阴影Miss（shadow_miss.rmiss）**：专用于阴影光线的极简着色器，仅执行`shadow_payload.visible = 1`。Caller在发射阴影光线前将`visible`预置为0（遮挡假设），Miss着色器在光线到达`tMax`无遮挡时覆盖该值，形成布尔可见性测试。

Sources: [miss.rmiss](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/miss.rmiss#L1-L32), [shadow_miss.rmiss](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/shadow_miss.rmiss#L1-L21)

## 共享工具库 (pt_common.glsl)

所有RT着色器包含的公共库，定义数据结构与数学工具：

**Payload定义**：`PrimaryPayload`（56字节，location 0）承载颜色贡献、下一光线原点/方向、吞吐量更新系数、命中距离和反弹索引；`ShadowPayload`（4字节，location 1）承载可见性布尔值。

**Buffer Reference**：通过`GL_EXT_buffer_reference`扩展直接访问顶点/索引缓冲区设备地址，避免传统Descriptor Set绑定。`VertexBuffer`结构匹配C++端56字节顶点布局（position+normal+uv0+tangent+uv1），`IndexBuffer`提供uint32索引访问。

**射线原点偏移**：实现Wächter & Binder算法（Ray Tracing Gems第6章），通过浮点位操作将原点沿几何法线方向偏移，避免自交浮点精度问题。该方法无需场景相关的epsilon值，在所有尺度下保持鲁棒。

**随机数生成**：结合Sobol低差异序列（128维预计算方向数）与蓝噪声Cranley-Patterson旋转。每维度使用空间偏移（`dim * 73/127`）从128×128蓝噪声纹理采样偏移量，叠加黄金比例加扰的帧种子实现时域去相关。超过128维时退化为PCG哈希。

**BRDF采样工具**：`sample_ggx_vndf`实现Heitz 2018的可见法线分布函数采样，`sample_cosine_hemisphere`提供漫反射半球采样，`russian_roulette`实现基于吞吐量最大分量的生存概率计算，`mis_power_heuristic`提供幂启发式多重重要性采样权重。

Sources: [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L1-L417)

## 绑定布局与数据流

RT管线使用扩展的Set 0绑定布局，在标准全局数据基础上增加RT专用资源：

| 绑定 | 类型 | 用途 |
|------|------|------|
| 4 | `accelerationStructureEXT` | TLAS（顶层加速结构）用于光线遍历 |
| 5 | `GeometryInfo` SSBO | 每几何体设备地址和材质索引数组 |

Set 3通过Push Descriptor动态绑定每帧变化的资源：binding 0为累积图像（rgba32f），binding 1-2为OIDN辅助图像（反照率rgba8、法线rgba16f），binding 3为Sobol方向数缓冲区（128×32位=16KB）。

Push Constants（20字节）与Rasterization管线布局不兼容，因此RT Pass拥有独立的Pipeline Layout，避免Set布局冲突。

Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L149-L170)

## 与渲染系统的集成

`render_path_tracing`函数构建简化的Render Graph：ReferenceViewPass生成HDR累积缓冲区，TonemappingPass将其色调映射到交换链，ImGui Pass叠加UI。累积缓冲区的内容在相机或IBL旋转变化时通过`reset_accumulation()`重置，确保时域一致性。

路径追踪Pass与OIDN降噪器紧密集成，在每次渲染循环中提取辅助图像传递给降噪器，实现快速收敛的交互式预览。

Sources: [renderer_pt.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_pt.cpp#L1-L106)

如需了解光线追踪加速结构的构建与场景表示，请参阅[RT基础设施与加速结构](https://github.com/1PercentSync/himalaya/blob/main/25-rtji-chu-she-shi-yu-jia-su-jie-gou)页面；关于路径追踪算法的完整理论背景，请参阅[路径追踪参考视图](https://github.com/1PercentSync/himalaya/blob/main/26-lu-jing-zhui-zong-can-kao-shi-tu)页面。