本文档记录 Himalaya 渲染器在 Milestone 1–Milestone 3 之后的技术路线图，涵盖画质提升、性能优化、场景系统扩展以及神经网络渲染等前沿方向。所有远期目标都附有明确的触发条件，避免无条件实现带来的架构债务。

---

## 技术演进全景

Himalaya 采用渐进式架构设计，远期目标与当前架构能力形成递进关系：

| 架构基础（M1-M3） | 远期演进方向 |
|------------------|-------------|
| Bindless 描述符系统 | 神经网络 shader 内推理（Cooperative Vectors） |
| Render Graph 资源管理 | 异步资源加载 + Streaming 管线 |
| RT 基础设施 | NRC 神经辐射缓存替代传统 GI 缓存 |
| Lightmap + SSGI | Irradiance Probes + SDF GI |
| 四层架构（RHI→Framework→Passes→App） | 百万级 GPU 粒子、虚拟纹理 |

Sources: [docs/project/architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L1-L223), [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L1-L97)

---

## 画质提升方向

### 大气与环境效果

| 目标 | 复杂度 | 触发条件 | 前置依赖 |
|------|--------|----------|----------|
| **体积云** | 最高 | 2D 云层无法满足需求 | Ray March + 3D 噪声 + 时域重投影 + 半分辨率渲染 |
| **Bokeh DOF** | 中等 | Gaussian DOF 视觉不足 | 半分辨率 gather-based 实现 |
| **Bruneton 大气散射** | 已完成（M2） | — | 替换静态 Cubemap 天空 |

**体积云**是整个技术栈中复杂度最高的单一模块，需要集成 Ray Marching、3D Perlin/Worley 噪声采样、时域重投影降噪、半分辨率渲染还原以及大气散射光照交互。2D 云层配合 Bruneton 天空已能提供足够的室外画面质量，仅在演示场景对云层有明确要求时才考虑实现。

### 次表面散射（SSS）演进线

```
Pre-Integrated SSS (M3+ 角色需要时)
    ↓
Screen-Space SSS (远期条件性实现)
```

- **Pre-Integrated SSS**：LUT 替代 Lambert 漫反射，成本极低（一张预积分纹理），是角色渲染的基础 SSS 方案
- **Screen-Space SSS**：提供质变级的真实皮肤感，但需处理轮廓渗色问题（通过深度/法线不连续性检测），仅在角色渲染品质成为首要目标时实施

### HDR 与广色域

| 目标 | 技术要点 | 触发条件 |
|------|----------|----------|
| HDR 输出 | HDR10 / scRGB 输出管线 | 显示设备支持 + 演示需要 |
| 广色域内部渲染 | ACEScg / Rec.2020 工作空间 | 输入贴图色域转换基础设施就绪 |

HDR 输出需要维护两套 Tonemapping 参数（SDR 与 HDR）、UI 亮度适配以及 HDR 校准界面。当前 sRGB 工作空间已足够，架构已预留色域扩展能力。

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L9-L16), [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L33-L36)

---

## 场景系统扩展

### 水体渲染

静态水体渲染的大部分需求已被现有基础设施覆盖：
- **反射**：SSR 提供屏幕空间精确反射
- **折射**：屏幕空间折射（需实现深度着色方案）
- **菲涅尔**：PBR 标准 Fresnel 计算

额外工作量集中在：深度着色（水下物体扭曲效果）、法线贴图动画、法线计算投影焦散（可预烘焙为 Lightmap）、岸线泡沫效果。

### 地形系统

仅在大面积自然地形场景需要时实现：
- **Heightmap Clipmap LOD**：多级细节地形网格
- **Splatmap 材质混合**：基于权重图的多材质混合
- **Mesh 补全**：洞穴、悬崖等无法用 Heightmap 表达的局部使用独立 Mesh 补充

### 粒子系统演进

| 阶段 | 技术方案 | 粒子规模 | 特性 |
|------|----------|----------|------|
| 当前 | CPU 粒子 | 万级 | 基础特效能力 |
| 远期 | GPU 粒子（Compute Shader） | 百万级 | 深度碰撞检测、Froxel 体积雾配合着色 |

GPU 粒子使用 Compute Shader 实现，支持百万级粒子并发和基于场景深度的碰撞检测，与 Froxel Volumetric Fog 配合实现体积光柱中的粒子光照效果。

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L21-L26), [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L51-L53)

---

## 透明与材质系统

### 顺序无关透明（WBOIT）

当简单排序（Painter's Algorithm）出现实际排序问题时切换至 Weighted Blended OIT：
- 单个 Pass 完成，无需排序
- 性能固定且较低（与场景复杂度无关）
- 适用于头发、植被等复杂透明叠加场景

### 虚拟纹理与 Streaming

| 目标 | 触发条件 | 实现策略 |
|------|----------|----------|
| 异步资源加载框架 | 所有 Streaming 的前置依赖 | 后台线程加载 + Vulkan Transfer Queue 异步上传 |
| 纹理 Mip Streaming | 纹理总量超出显存预算 | 按屏幕占比/距离动态加载 mip 级别 |
| Lightmap Streaming | 多套 Lightmap 数据量大 | BC6H 压缩 + 区域分块加载 |

**Virtual Texturing**：明确不实现，但 Lightmap 采样封装为统一接口预留替换可能。若未来场景规模确实需要，可在不改动上层代码的前提下替换实现。

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L29-L36), [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L43-L46)

---

## 神经网络渲染与算法演进

这是渲染技术的前沿方向，依赖硬件 Tensor Core 能力和标准化 API 演进。

### 神经辐射缓存（NRC）

使用神经网络替代 [M2 里程碑](https://github.com/1PercentSync/himalaya/blob/main/28-milestone-2-hua-zhi-quan-mian-ti-sheng) 的 SHaRC 或 [M3 里程碑](https://github.com/1PercentSync/himalaya/blob/main/29-milestone-3-dong-tai-wu-ti-yu-xing-neng-you-hua) 的 ReSTIR GI 缓存层：
- 更高精度的间接光缓存
- 依赖 NVIDIA Tensor Core 进行实时推理
- 在 [Milestone 2 实时 PT 模式](https://github.com/1PercentSync/himalaya/blob/main/28-milestone-2-hua-zhi-quan-mian-ti-sheng) 成熟后作为升级选项

### DLSS Ray Reconstruction

神经网络替代 NRD 传统降噪器：
- 单 Pass Transformer 推理
- NVIDIA 专有技术，跨平台项目慎用
- 仅在 NVIDIA 生态演示场景考虑

### Cooperative Vectors

DXR 1.2 / SM 6.9 标准化的 shader 内神经网络推理 API：
- 使 NRC、神经材质等技术跨厂商可用
- 解决当前神经网络渲染的厂商锁定问题
- 等待标准化实现后评估迁移

### ReSTIR PT

GRIS（Generalized Resampled Importance Sampling）框架下对完整光传输路径做重采样：
- 统一替代 ReSTIR DI（直接光）和 ReSTIR GI（间接光）分离架构
- 单一套算法处理所有光传输路径
- 在现有 ReSTIR 基础设施成熟后演进

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L59-L66)

---

## 明确排除的技术

以下技术经评估后明确不实现，记录理由以供未来复盘：

| 技术 | 排除理由 |
|------|----------|
| **GPU-Driven Rendering** | 复杂度弥散到整个架构，Vulkan 多线程 Command Buffer + 几千到上万 drawcall 并非项目瓶颈 |
| **Mesh Shader** | 移动端不支持，无 GPU-Driven 时收益有限 |
| **HLOD** | 离线处理工具链开发成本高，场景规模不大时不需要 |
| **Nanite-style 虚拟几何** | 个人项目从零实现不现实 |
| **Virtual Shadow Maps** | 实现极复杂（虚拟纹理系统 + 页面管理 + GPU-driven culling），CSM 足以满足需求 |
| **Visibility Buffer** | 公开完整实现和资料相对少，不符合"资料丰富、AI 辅助可靠"的项目约束 |

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L69-L78)

---

## 混合管线演进路线

Himalaya 的长期演进方向是光栅化 + 光线追踪混合管线，以下是已完成和规划中的技术项：

| 技术 | 说明 | 状态 |
|------|------|------|
| RT 烘焙管线 | GPU PT 烘焙 Lightmap + Reflection Probes | **[M1 已排入](https://github.com/1PercentSync/himalaya/blob/main/27-milestone-1-jing-tai-chang-jing-yan-shi)** |
| PT 参考视图 | Accumulation debug 渲染 + OIDN viewport denoising | **[M1 已排入](https://github.com/1PercentSync/himalaya/blob/main/27-milestone-1-jing-tai-chang-jing-yan-shi)** |
| RT Reflections | 替换 SSR + Reflection Probes | **[M2 已排入](https://github.com/1PercentSync/himalaya/blob/main/28-milestone-2-hua-zhi-quan-mian-ti-sheng)** |
| RT Shadows | 替换 CSM / PCSS | **[M2 已排入](https://github.com/1PercentSync/himalaya/blob/main/28-milestone-2-hua-zhi-quan-mian-ti-sheng)** |
| 实时 PT | ReSTIR DI + SHaRC + NRD | **[M2 已排入](https://github.com/1PercentSync/himalaya/blob/main/28-milestone-2-hua-zhi-quan-mian-ti-sheng)** |
| ReSTIR GI | 替换 SHaRC，间接光质量升级 | **[M3 已排入](https://github.com/1PercentSync/himalaya/blob/main/29-milestone-3-dong-tai-wu-ti-yu-xing-neng-you-hua)** |
| RTAO | 替换 GTAO，接口一致 | **未排入**（GTAO 观感尚可） |

RTAO 未排入的原因是与 GTAO 的接口一致（输入场景 → 输出单通道遮挡纹理），但 GTAO 在当前场景下的观感已满足需求，除非有明确画质提升需求否则不替换。

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L81-L93)

---

## 角色相关特性

以下特性仅在项目引入角色模型后才考虑实现：

| 演进线 | 说明 |
|--------|------|
| SSS 演进 | Pre-Integrated SSS → Screen-Space SSS |
| 卡通渲染角色专属 | 面部阴影控制、描边、头发渲染等角色特有需求，依赖 M3 场景卡通渲染基础 |

角色渲染需要完整的角色模型资产和动画系统，当前以静态场景为主，预留架构支持但不主动实现。

Sources: [docs/roadmap/milestone-future.md](https://github.com/1PercentSync/himalaya/blob/main/docs/roadmap/milestone-future.md#L95-L97)

---

## 阅读指引

远期目标规划与以下文档形成完整的项目路线图：

- [Milestone 1 - 静态场景演示](https://github.com/1PercentSync/himalaya/blob/main/27-milestone-1-jing-tai-chang-jing-yan-shi)：RT 基础设施、PT 参考视图
- [Milestone 2 - 画质全面提升](https://github.com/1PercentSync/himalaya/blob/main/28-milestone-2-hua-zhi-quan-mian-ti-sheng)：实时 PT 模式、混合 RT 效果
- [Milestone 3 - 动态物体与性能优化](https://github.com/1PercentSync/himalaya/blob/main/29-milestone-3-dong-tai-wu-ti-yu-xing-neng-you-hua)：动态物体支持、间接光升级

技术决策参考文档：

- [技术选型原则与理念](https://github.com/1PercentSync/himalaya/blob/main/31-ji-zhu-xuan-xing-yuan-ze-yu-li-nian)
- [架构约束与边界](https://github.com/1PercentSync/himalaya/blob/main/32-jia-gou-yue-shu-yu-bian-jie)