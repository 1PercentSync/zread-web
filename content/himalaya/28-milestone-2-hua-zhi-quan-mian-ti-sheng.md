**Milestone 2 (M2)** 是 Himalaya 渲染器从"基础可用"迈向"视觉质变"的关键阶段。在 Milestone 1 建立的完整静态场景渲染基础设施之上，M2 通过屏幕空间光线追踪、时域降噪、物理正确的大气散射和实时路径追踪等技术，将画面写实度提升到次世代游戏水准。本阶段的核心设计哲学是**吃掉所有低垂的果实（low-hanging fruits）**——以合理的工程投入换取最大的视觉回报。

## M2 技术目标总览

M2 的目标是实现**双重渲染质量跃升**：

**光栅化模式**下，画面将获得动态天空昼夜变化、距离相关的软阴影、屏幕空间精确反射与间接光照、物理正确的大气散射与雾效，以及通过 FSR/DLSS 实现的高质量抗锯齿与超分辨率。

**路径追踪模式（PT Mode）** 提供实时路径追踪渲染能力，集成 ReSTIR DI 直接光照、SHaRC 空间哈希辐射缓存和 NRD 实时降噪，画面水平对标 DOOM: The Dark Ages 的路径追踪模式。混合 RT 效果（RT Reflections、RT Shadows）则在光栅化管线中选择性替换视觉瑕疵最明显的环节。

---

## M1 阶段为 M2 奠定的基础设施

M2 的大量技术并非从零开始，而是建立在 M1 阶段精心设计的扩展性架构之上。

### 时域数据基础设施

M1 阶段四和阶段五构建的时域数据系统是 M2 众多效果的基石。`framework::FrameContext` 携带了完整的时域矩阵与历史帧资源引用，包括 `prev_view_projection` 用于重投影、`frame_number` 用于时域抖动、`depth_prev` 历史深度缓冲等。这套机制最初为 GTAO 的时域降噪而设计，但在架构上完全通用化，支持任何需要时域累积和重投影的效果。AOTemporalPass 的三层拒绝策略（UV 有效性、深度一致性、邻域钳制）已成为项目的标准时域处理范式。

### GTAO 与环境光遮蔽管线

M1 阶段五实现的 GTAO（Ground-Truth Ambient Occlusion）是 M2 所有屏幕空间效果的原型。该管线包含三个计算 Pass：GTAOPass 执行结构化的地平线搜索与解析积分，AOSpatialPass 执行 5x5 边缘感知双边模糊，AOTemporalPass 完成时域滤波与历史混合。这种"原始计算 → 空间降噪 → 时域累积"的三阶段架构直接复用于 M2 的 SSR 和 SSGI 实现。特别值得注意的是 GTAO 同时输出的**弯曲法线（Bent Normal）**，它不仅是 GTSO（Ground-Truth Specular Occlusion）的输入，更为 SSGI 的光线方向提供了先验分布，实现算法间的协同优化。

### 阴影系统与 PCSS 基础

M1 阶段四建立的级联阴影映射（CSM）系统在 M2 扩展为支持距离相关软阴影的 PCSS（Percentage-Closer Soft Shadows）。`shadow.glsl` 中实现的 Blocker Search 和可变半径 PCF 滤波，配合 `cascade_light_size_uv` 和 `cascade_pcss_scale` 等逐级联参数，让阴影边缘的半影宽度随遮挡距离自然变化。这一基础将在 M2 升级为 RT Shadows 的混合方案，在阴影贴图分辨率不足和级联边界处自动切换为光线追踪阴影，消除锯齿和过渡痕迹。

### RT 基础设施（M1 阶段六）

M1 最后阶段构建的完整 RT 技术栈是 M2 路径追踪模式的根基。从 RHI 层的 `AccelerationStructureManager`（管理 BLAS/TLAS 构建）、`RTPipeline`（封装 SBT 和 trace_rays 命令），到 `SceneASBuilder`（将场景数据转化为 GPU 加速结构），再到 `ReferenceViewPass`（累积式路径追踪），整个链路已在 M1 验证通过。M2 将在此基础上引入 ReSTIR DI 的蓄水池时空重采样、SHaRC 的间接光缓存查表，以及 NRD 的多算法降噪器。

---

## M2 光栅化模式效果详解

### GTAO 时域降噪管线

GTAO 在 M2 获得完整的时域降噪支持，显著降低采样数的同时保持时间稳定性。该管线由三个 Pass 组成，通过 Render Graph 按序调度：

**GTAOPass**（`passes/src/gtao_pass.cpp`）在每像素上执行结构化的地平线搜索。Compute Shader（`shaders/gtao.comp`）沿 8 个方向执行射线步进，计算余弦加权的可见性积分。输出包含 RGBA8 格式的弯曲法线（RGB 通道，编码为 $n \times 0.5 + 0.5$）和漫反射 AO（A 通道）。关键参数通过 Push Constants 传递，包括采样半径、方向数、每方向步进数和薄遮挡物补偿系数。

**AOSpatialPass**（`passes/src/ao_spatial_pass.cpp`）执行 5x5 的边缘感知双边模糊。`shaders/ao_spatial.comp` 使用预计算的高斯核权重（$\sigma=1.5$），结合基于线性深度的边缘权重函数 `depth_edge_weight()`，防止跨深度不连续处泄漏。该 Pass 采用**路径累积的边缘检测**策略：沿高斯核的采样路径累积深度边缘权重，有效阻止通过薄几何体的"隧道效应"。

**AOTemporalPass**（`passes/src/ao_temporal_pass.cpp`）完成时域滤波，是 M2 时域技术的重要展示。`shaders/ao_temporal.comp` 实现了三层拒绝策略：UV 有效性检测（历史像素超出屏幕范围时完全拒绝）、深度不一致性检测（相对深度差超过 5% 视为遮挡变化）、邻域钳制（将历史值钳制在当前帧 3x3 邻域的 min-max 范围内防止 ghosting）。最终通过指数移动平均混合当前帧与历史帧。

Sources: [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L1-L177), [gtao.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L1-L286), [ao_spatial.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_spatial.comp#L1-L158), [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L1-L182)

### 接触阴影（Contact Shadows）

接触阴影 Pass 解决了 CSM 在物体与地面接触处的分辨率不足问题。作为独立的屏幕空间 Pass，它在 `forward.frag` 的主光照计算后执行，仅对接受阴影的像素进行精细的射线步进。

`passes/include/himalaya/passes/contact_shadows_pass.h` 定义了 ContactShadowsPass 类，其执行流程遵循 M2 计算 Pass 的标准模式：读取当前帧的深度和法线缓冲，沿光线方向执行短距离（典型 1-2 米）的屏幕空间射线追踪，检测与相邻物体的遮挡关系。相比 CSM，接触阴影能以像素级精度呈现物体与地面接触处的细腻阴影，且不受级联分辨率限制。

Sources: [contact_shadows_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/contact_shadows_pass.h)

### 级联阴影映射与 PCSS

M2 的阴影系统在 M1 CSM 基础上引入了距离相关的软阴影。`shaders/common/shadow.glsl` 提供了完整的 PCSS 实现：

**Blocker Search** 阶段在待着色点周围的阴影贴图空间中采样深度，计算平均遮挡物深度与接收者深度的差值。采样使用预计算的 Poisson Disk 分布（32 个样本），支持随机旋转以分散噪声。

**半影宽度估计** 基于光线角度直径和遮挡距离计算。`shadow_pcss_scale` 参数将世界空间距离转换为阴影贴图 UV 空间的滤波半径，确保远处物体的阴影更软、近处物体的阴影更锐利。

**可变半径 PCF** 根据估计的半影宽度动态调整采样半径，但受 `kMaxPenumbraTexels`（64 texels）限制以防止核爆炸。采样使用 49 个 Poisson Disk 样本，在质量与性能间取得平衡。

级联混合策略在 M2 接受评估：M1 实现的 `blend_cascade_shadow()` 使用线性插值（lerp），M2 将实测其与抖动（dithering）+ FSR/DLSS 组合的观感和性能，决定是否切换。Lerp 在 PCSS 下会使 blend region 的采样成本翻倍，而 dithering 配合时域超分辨率可完全消除视觉瑕疵。

Sources: [shadow.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/shadow.glsl#L1-L496), [shadow_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/shadow_pass.h#L1-L155)

### 色调映射与 HDR 管线

`passes/include/himalaya/passes/tonemapping_pass.h` 定义了最终的色调映射 Pass。`shaders/tonemapping.frag` 实现了 ACES 电影级色调映射曲线（Narkowicz 2015 拟合），将 HDR 颜色映射到 LDR 显示范围。

该 Pass 的全屏三角形绘制读取 `rt_hdr_color`（Set 2 binding 0）中的 HDR 场景颜色，应用 `global.camera_position_and_exposure.w` 中存储的曝光值，然后通过 ACES 曲线压缩。Swapchain 的 SRGB 格式确保硬件自动执行线性到 sRGB 的伽马转换。

对于调试渲染模式（如可视化法线、AO、粗糙度等材质属性），着色器直接透传 HDR 值，跳过曝光和色调映射，确保属性值在屏幕上线性呈现。

Sources: [tonemapping_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/tonemapping_pass.h#L1-L107), [tonemapping.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/tonemapping.frag#L1-L48)

---

## M2 极低工作量优化项

以下优化仅需改动数行至数十行代码，但能带来显著的视觉提升：

| 技术 | 实现位置 | 视觉影响 |
|------|---------|---------|
| **Burley Diffuse** | `forward.frag` 漫反射 BRDF | 替换 Lambert，粗糙表面在掠射角的观感更真实（Disney 2012） |
| **Film Grain** | 新增后处理 Pass | 增加画面质感，掩盖低精度计算的色带（banding）伪影 |
| **Chromatic Aberration** | 色调映射 Pass 扩展 | 在屏幕边缘模拟镜头色散，增强镜头感 |
| **多方向光 CSM** | `Renderer` shadow 数据结构 | M1 限制 1 盏方向光，M2 扩展为 N 盏，每盏独立 shadow map + cascade 数据 |
| **PCSS 质量评估** | `shadow.glsl` blend 策略 | 实测 lerp vs dithering + FSR 的观感与性能，决定级联边界混合策略 |

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L1-L308), [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L1-L75)

---

## M2 低工作量效果项

### 屏幕空间反射（SSR）

SSR 是 M2 光栅化模式的核心升级之一。它与 SSGI 共享大量的 Ray March 基础设施：从屏幕空间射线构造、基于 Hierarchical Z-Buffer 的步进加速，到命中点的颜色重建。

在光滑地面和金属表面，SSR 提供**像素级精确的镜面反射**，完全消除了 Reflection Probes 的低频近似失真和位置依赖误差。这对于室内场景的大理石地面、水面、抛光金属等材质具有**质变级**的视觉影响。

实现上，SSR Pass 将在 GTAO 管线的空间降噪阶段之后执行，复用已解析的深度和法线缓冲。射线方向由反射向量确定，使用与 GTAO 相同的屏幕空间位置重建逻辑。命中后的颜色将通过双线性采样获取，并结合粗糙度进行模糊程度控制。

### Tiled Forward（光源裁剪）

从 M1 的暴力 Forward 升级为 2D 屏幕 Tile 光源裁剪。Compute Pass 将屏幕划分为 16x16 或 32x32 像素的 Tile，每 Tile 执行一次光源包围盒与视锥的相交测试，生成该 Tile 的有效光源列表。

Forward Pass 的像素着色器改为读取 Tile 光源列表而非遍历全部光源，光源数量增加时的性能从线性下降变为次线性。这是 SSGI 和室内多光源场景的必备基础。

### 屏幕空间上帝光（Screen-Space God Rays）

作为体积渲染前的占位方案，该后处理 Pass 对光源屏幕空间位置执行径向模糊，模拟光线在介质中的散射。虽然物理正确性不如 Froxel Volumetric Fog（M3），但仅需三四十行 shader 代码即可实现显著的体积感，是 M2 性价比极高的效果项。

### FSR SDK 集成

M1 的 MSAA 仅解决几何锯齿，对着色闪烁和高频反射噪点无能为力。M2 引入 FidelityFX Super Resolution SDK，提供统一的时域抗锯齿（TAA）和上采样接口。

对于静态场景，仅需相机 jitter 即可激活 FSR 的时域累积逻辑。FSR 的 RCAS（Robust Contrast Adaptive Sharpening）锐化还能恢复 TAA 可能柔化的细节，实现优于原生分辨率的视觉质量。

---

## M2 中等工作量效果项

### 屏幕空间全局光照（SSGI）

SSGI 与 SSR 共享 Ray March 基础代码，但追踪的是**漫反射方向的间接光照**。它采样与 GTAO 相同的方向分布（由弯曲法线引导），但执行完整的蒙特卡洛路径追踪——射线命中表面后采样其直接光照作为间接贡献。

SSGI 的输出叠加在 Lightmap 之上，为静态烘焙光照补充屏幕空间的动态细节。当物体靠近红墙时，SSGI 能让白色物体呈现正确的红色间接光晕染，这是 Lightmap 无法实现的动态 color bleeding 效果。

### Bruneton 大气散射

替换 M1 的静态 HDR Cubemap 天空，实现完整的物理大气散射模拟。该方案同时提供：

- **动态天空**：支持昼夜变化的 Rayleigh/Mie 散射
- **Aerial Perspective**：远处物体的颜色渐变和对比度衰减（替换 M1 的高度雾）
- **精确的太阳盘和天空颜色**：基于物理的太阳辐射和大气成分

Bruneton 2016 的预计算大气散射模型在质量和性能间取得了最佳平衡，仅需一次 3D LUT 查找即可获取任意太阳高度和视角方向的散射结果。

### 视差遮蔽映射（POM）

POM 在像素着色器中执行射线步进，模拟表面的深度感。对于砖墙、石板路等具有明显高度变化的材质，POM 能呈现正确的自遮挡和视差效果，相比单纯的法线贴图大幅提升表面立体感。

实现将扩展材质系统，添加 `height_map` 纹理槽和 `height_scale` 参数。Forward Pass 的像素着色器在采样基础颜色之前执行 POM 的纹理坐标偏移计算。

### 景深与运动模糊

**Gaussian DOF** 按深度对场景执行选择性模糊，模拟相机的对焦效果。虽然不如后续的 Bokeh DOF 物理精确，但实现简单且性能友好。

**Camera Motion Blur** 基于相机运动向量计算每像素的模糊方向，在相机快速移动时呈现动态模糊效果。静态场景仅需相机的重投影矩阵即可计算运动向量，无需 per-object motion vectors（M3）。

---

## M2 路径追踪（PT）模式

M2 引入完整的实时路径追踪渲染模式，画面水平对标 DOOM: The Dark Ages 的 PT Mode。该模式基于 M1 阶段六建立的 RT 基础设施，集成以下核心技术：

### ReSTIR DI（直接光照）

ReSTIR（Reservoir-based Spatio-Temporal Importance Resampling）将直接光照采样提升到百万级光源的高效处理能力。其核心技术包括：

- **初始候选采样**：每像素从完整光源列表中均匀采样少量候选
- **蓄水池重采样**：使用蓄水池数据结构维护加权重采样分布
- **空间复用**：相邻像素的蓄水池在 3x3 或 5x5 范围内交换候选，利用光照的局部相关性
- **时域复用**：前一帧的有效蓄水池经重投影后与本帧合并，指数级降低噪声

### SHaRC（间接光缓存）

SHaRC（Spatial Hash Radiance Cache）解决间接光路径的无限反弹问题。当路径的反弹次数达到限制（如 2 次）或 Russian Roulette 终止时，查询空间哈希网格中存储的预计算辐射度，而非继续追踪。

空间哈希以世界坐标为键，将场景划分为均匀网格。每个网格单元存储该位置各方向的近似入射辐射度，通过球面高斯或二阶球谐函数编码。这种**路径提前终止 + 缓存查询**策略让有限路径长度的 PT 呈现接近无限反弹的质量。

### NRD 实时降噪

NRD（NVIDIA Real-time Denoisers）为 PT 的不同信号提供专门的降噪器：

- **ReBLUR**：处理间接光漫反射，利用时域累积和引导滤波
- **ReLAX**：专门为 ReSTIR 信号设计，保留高频细节的同时去除噪声
- **SIGMA**：针对阴影信号的单帧降噪，消除硬阴影边缘的噪点

NRD 与路径追踪管线深度集成：ReferenceViewPass 在 bounce 0 写入 OIDN 辅助图像（albedo + normal），这些几何/材质引导数据显著提升降噪器的边缘保持能力。

### 混合 RT 效果

对于光栅化模式，M2 提供**选择性光线追踪增强**，仅替换视觉瑕疵最明显的效果：

| 混合效果 | 替换目标 | 技术优势 |
|---------|---------|---------|
| **RT Reflections** | SSR + Reflection Probes | 消除 SSR 屏幕边缘消失和 Probe 低频失真，光栅化最大视觉短板 |
| **RT Shadows** | CSM / PCSS | 消除 shadow map 分辨率锯齿、级联边界过渡、远处物体阴影消失 |

这些混合效果通过统一的 RT Pipeline 调度，与光栅化几何 Pass 共享 TLAS 和场景数据，切换成本低且易于用户配置。

---

## 效果依赖关系与实现顺序

M2 各项效果的实现存在逻辑依赖，推荐的开发顺序如下：

```
1. Burley Diffuse + Film Grain + Chromatic Aberration
         ↓
2. SSR Pass (与 GTAO 共享深度/法线基础设施)
         ↓
3. SSGI Pass (复用 SSR 的 Ray March 代码)
         ↓
4. Tiled Forward (光源裁剪，支撑 SSGI 的多光源场景)
         ↓
5. Bruneton 大气散射 + Aerial Perspective
         ↓
6. FSR SDK 接入 (为后续时域效果提供基础)
         ↓
7. POM + Gaussian DOF + Camera Motion Blur
         ↓
8. ReSTIR DI + SHaRC (PT 模式直接/间接光)
         ↓
9. NRD 集成 (PT 模式降噪)
         ↓
10. RT Reflections + RT Shadows (混合 RT 效果)
```

时域基础设施（AOTemporalPass 中的重投影、历史缓冲管理、时域混合）应在 SSR 之前完成泛化重构，确保 SSAO、SSR、SSGI 共享同一套时域框架。

---

## 与相邻里程碑的关系

**承接 M1**：M2 完全依赖 M1 建立的渲染基础设施——Render Graph 资源管理、Bindless 描述符系统、四层架构（RHI/Framework/Pass/Application）、时域数据管理和 RT 基础能力。没有 M1 的架构设计，M2 的复杂效果组合将难以维护。

**铺垫 M3**：M3 的动态物体支持依赖 M2 的 per-object motion vectors 基础设施（SSGI 和 SSR 的时域累积已需要 object ID 和 motion vector），而 M3 的 Clustered Forward 是 M2 Tiled Forward 的自然扩展。M2 的 Bruneton 大气为 M3 的 Froxel Volumetric Fog 提供散射计算基础。

如需深入了解 M1 的基础设施细节，请参阅 [Milestone 1 - 静态场景演示](https://github.com/1PercentSync/himalaya/blob/main/27-milestone-1-jing-tai-chang-jing-yan-shi)；对于 M3 的动态物体和性能优化规划，请参阅 [Milestone 3 - 动态物体与性能优化](https://github.com/1PercentSync/himalaya/blob/main/29-milestone-3-dong-tai-wu-ti-yu-xing-neng-you-hua)。