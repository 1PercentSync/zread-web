Himalaya 的材质系统采用**数据驱动的GPU中心化架构**，将材质定义完全卸载至GPU端存储，CPU仅保留轻量级的索引管理。这种设计配合 bindless 纹理系统，实现了大规模材质场景的高效渲染，同时保持与 glTF 2.0 规范的完全兼容。本文将从内存布局、数据流、管线集成三个维度剖析材质系统的架构设计。

## 核心设计哲学

材质系统的核心假设是**材质数据为只读场景资源**，在场景加载阶段确定，渲染阶段仅通过 SSBO 索引访问。这一约束带来了三个架构优势：首先，所有材质参数统一存储于单一 GPU 缓冲区，消除了 per-draw 的材质常量设置开销；其次，bindless 纹理索引机制使材质可以引用任意数量的纹理而不受描述符集限制；最后，材质数据布局与 glTF 2.0 规范严格对齐，实现了资产管道的零摩擦导入。

系统通过三级抽象管理材质生命周期：**框架层的 `MaterialSystem`** 管理 GPU 端 SSBO 生命周期，**纹理子系统** 处理纹理加载、压缩与 bindless 注册，**应用层的 `SceneLoader`** 负责解析 glTF 材质并构建 CPU 端材质数据数组。这种分层确保了材质资源管理的关注点分离。

```mermaid
flowchart TB
    subgraph CPU_Side["CPU Side - Scene Loading"]
        GLTF[glTF Asset<br/>Materials/Textures]
        SL[SceneLoader<br/>Build GPUMaterialData array]
        TS[TextureSystem<br/>BC Compression + Cache]
        DM[DescriptorManager<br/>Bindless Registration]
    end
    
    subgraph GPU_Side["GPU Side - Per Frame"]
        SSBO[(MaterialBuffer SSBO<br/>Set 0 Binding 2)]
        BIND1[Bindless Texture Array<br/>Set 1 Binding 0]
        FS[Forward Shader<br/>materials[material_index]]
    end
    
    GLTF -->|Parse| SL
    SL -->|Prepare textures| TS
    TS -->|Finalize + Register| DM
    DM -->|Write bindless indices| BIND1
    SL -->|Upload| SSBO
    SSBO -->|Index lookup| FS
    BIND1 -->|Sample| FS
```

**材质数据流架构**展示了从 glTF 资产到着色器访问的完整路径。SceneLoader 解析 glTF 后构建 `GPUMaterialData` 数组，纹理数据经 BC 压缩后通过 bindless 系统注册，最终材质 SSBO 与纹理数组在着色器端通过 `material_index` 关联。Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L1-L160), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L190)

## GPU 材质数据结构

`GPUMaterialData` 是材质系统的核心数据结构，采用 std430 内存布局，严格对齐至 16 字节边界，总大小 80 字节。该结构与 glTF 2.0 的 `pbrMetallicRoughness` 材质模型完全兼容，同时扩展支持标准 PBR 所需的全部参数。

| 字段 | 偏移 | 类型 | 语义 | glTF 对应 |
|------|------|------|------|-----------|
| `base_color_factor` | 0 | vec4 | 基础色乘数 (RGBA) | baseColorFactor |
| `emissive_factor` | 16 | vec4 | 自发光强度 (XYZ) | emissiveFactor |
| `metallic_factor` | 32 | float | 金属度乘数 | metallicFactor |
| `roughness_factor` | 36 | float | 粗糙度乘数 | roughnessFactor |
| `normal_scale` | 40 | float | 法线贴图强度 | normalTexture.scale |
| `occlusion_strength` | 44 | float | 遮挡贴图强度 | occlusionTexture.strength |
| `base_color_tex` | 48 | uint | 基础色纹理索引 | baseColorTexture |
| `emissive_tex` | 52 | uint | 自发光纹理索引 | emissiveTexture |
| `metallic_roughness_tex` | 56 | uint | 金属粗糙度纹理索引 | metallicRoughnessTexture |
| `normal_tex` | 60 | uint | 法线纹理索引 | normalTexture |
| `occlusion_tex` | 64 | uint | 遮挡纹理索引 | occlusionTexture |
| `alpha_cutoff` | 68 | float | Alpha 测试阈值 | alphaCutoff |
| `alpha_mode` | 72 | uint | 混合模式枚举 | alphaMode |
| `_padding` | 76 | uint | 对齐填充 | - |

**内存布局的关键设计决策**在于将所有纹理引用统一为 32 位 bindless 索引，而非传统的描述符集绑定。这使得单个材质可以引用多达 5 种纹理，而无需复杂的描述符集动态分配。`alpha_mode` 字段直接控制片元着色器的早期 discard 行为——值为 1 (Mask) 时启用 alpha 测试，值为 2 (Blend) 时由应用层路由至透明渲染队列。Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L38-L77), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L56-L78)

## 材质系统与管线集成

材质系统并非独立运行，而是深度嵌入 Render Graph 与 Bindless 描述符系统的协同架构中。理解这些集成点是正确使用材质系统的前提。

### 与 Bindless 纹理系统的协同

材质数据中的纹理字段存储的是 bindless 索引，指向全局纹理数组 `textures[]` (Set 1, Binding 0)。这要求纹理加载流程必须在材质上传之前完成，以获取有效的 bindless 索引。系统通过 `fill_material_defaults()` 函数处理纹理缺失情况：未指定的纹理字段(UINT32_MAX)会被替换为默认纹理的 bindless 索引——白色中性纹理用于颜色和材质属性，黑色纹理用于自发光，平坦法线纹理(0.5, 0.5, 1.0)用于法线槽位。

```cpp
// 默认纹理的语义角色
struct DefaultTextures {
    TextureResult white;        // (1,1,1,1) - 基础色/金属粗糙度/遮挡的默认值
    TextureResult flat_normal;  // (0.5,0.5,1,1) - 法线贴图默认值
    TextureResult black;        // (0,0,0,1) - 自发光默认值
};
```

这种设计确保了**着色器端无需分支判断纹理是否存在**，始终执行统一的采样指令，缺失纹理的贡献在数据层面即被 neutralized。Sources: [texture.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/texture.h#L180-L200), [material_system.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/material_system.cpp#L13-L35)

### 与渲染管线的数据流

在渲染阶段，材质数据的访问路径通过两级间接寻址实现：首先，InstanceBuffer (Set 0, Binding 3) 中的 `GPUInstanceData` 包含 `material_index` 字段；其次，着色器使用该索引访问 MaterialBuffer SSBO 获取完整材质参数。这一设计实现了材质实例复用——多个网格实例可引用同一材质，而仅需在 InstanceBuffer 中存储不同的索引。

前向渲染管线的片元着色器展示了典型的材质访问模式：

```glsl
// 从插值获取材质索引
uint material_index = frag_material_index;

// 查找材质数据
GPUMaterialData mat = materials[material_index];

// 使用 bindless 索引采样纹理
vec4 base_color = texture(textures[nonuniformEXT(mat.base_color_tex)], frag_uv0)
                  * mat.base_color_factor;
```

`nonuniformEXT` 修饰符至关重要——它告知编译器材质索引可能在 warp 内发散，需要生成正确的 bindless 访问代码。Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L133-L145), [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L85-L125)

## 纹理处理与压缩管线

材质系统的纹理子系统负责将 glTF 引用的图像资源转换为 GPU 高效的压缩格式。该子系统实现了完整的 CPU 端纹理处理管线：图像解码、mipmap 生成、BC 压缩、缓存管理，最终通过 bindless 系统注册。

### 纹理角色与格式映射

系统根据纹理的语义角色选择压缩格式，而非统一处理：

| 角色 (TextureRole) | GPU 格式 | 压缩算法 | 颜色空间 | 应用场景 |
|-------------------|----------|----------|----------|----------|
| `Color` | BC7_SRGB | ISPC BC7e | sRGB | 基础色、自发光 |
| `Linear` | BC7_UNORM | ISPC BC7e | Linear | 金属度、粗糙度、遮挡 |
| `Normal` | BC5_UNORM | RGBCX BC5 | Linear | 法线贴图 (RG存储，Z重建) |

**法线贴图的特殊处理**采用 BC5 双通道压缩存储切线空间法线的 X 和 Y 分量，Z 分量在片元着色器中通过 `sqrt(1.0 - x² - y²)` 重建。这比 BC7 存储完整 RGB 法线更节省带宽(128 bits vs 256 bits per 4x4 block)，且精度更高。Sources: [texture.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/texture.h#L25-L38), [texture.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/texture.cpp#L1-L200)

### 纹理加载流水线

纹理处理采用三阶段流水线设计，支持并行化与缓存复用：

1. **准备阶段 (`prepare_texture`)**：图像解码 → 检查缓存 → BC 压缩 → 返回 `PreparedTexture`
2. **终化阶段 (`finalize_texture`)**：GPU 上传 → bindless 注册 → 返回 `TextureResult`
3. **便捷包装 (`create_texture`)**：串行执行准备+终化

分离准备与终化的设计允许场景加载器在多线程中并行压缩大量纹理，仅在最终的 immediate command scope 中串行执行 GPU 上传。缓存系统通过内容哈希(source_hash)避免重复压缩已处理过的纹理资产。Sources: [texture.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/texture.h#L100-L180)

## 着色器端材质计算

材质系统的最终输出是片元着色器中的光照计算。前向渲染管线实现了完整的 Cook-Torrance BRDF 配合 Split-Sum IBL，材质参数驱动着色器的每个计算环节。

### 材质属性驱动的光照分解

着色器首先解构材质参数，然后分别计算直接光照与环境光照：

```glsl
// 金属度工作流分离
vec3 F0 = mix(vec3(0.04), base_color.rgb, metallic);
vec3 diffuse_color = base_color.rgb * (1.0 - metallic);

// Cook-Torrance 直接光照
vec3 direct_diffuse = (1.0 - F) * diffuse_color * INV_PI * radiance;
vec3 direct_specular = D * Vis * F * radiance;

// Split-Sum IBL 环境光照
vec3 ibl_diffuse = irradiance * diffuse_color;
vec3 ibl_specular = prefiltered * (F0 * brdf_lut.x + brdf_lut.y);
```

**金属度工作流的数学本质**在于将基础色分离为介电体的漫反射分量与金属体的镜面反射分量。F0(0.04) 是 4% 反射率的物理默认值，适用于绝大多数非金属材质。材质系统通过 `metallic_factor` 控制这一混合比例。Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L210-L290)

### 环境光遮蔽集成

材质系统不仅提供材质参数，还作为 SSAO 与材质 AO 的集成点。片元着色器执行多级 AO 合成：

1. **材质 AO**：从 `occlusion_tex` 采样，经 `occlusion_strength` 缩放
2. **屏幕空间 AO (SSAO)**：从 GTAO 通道输出的 `rt_ao_texture` 采样
3. **漫反射 AO**：结合 SSAO 与材质 AO，应用 multi-bounce 颜色补偿
4. **镜面反射 AO**：通过 Lagarde 近似或 GTSO 模型计算

```glsl
// AO 合成示例
float material_ao = texture(textures[nonuniformEXT(mat.occlusion_tex)], frag_uv0).r;
material_ao = 1.0 + mat.occlusion_strength * (material_ao - 1.0);
float combined_ao = ssao * material_ao;
vec3 diffuse_ao = multi_bounce_ao(combined_ao, diffuse_color);
```

这种设计体现了材质系统的扩展性——SSAO 计算完全独立于材质系统运行，但材质系统提供了标准化的 AO 应用接口。Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L250-L280)

## Alpha 模式与渲染队列

材质系统通过 `AlphaMode` 枚举影响 CPU 端的渲染队列路由，而非仅作为 GPU 着色器参数。这是材质系统与渲染管线深度集成的关键体现。

| Alpha 模式 | GPU 值 | 片元着色器行为 | 渲染队列路由 |
|-----------|--------|----------------|-------------|
| `Opaque` | 0 | 无 Alpha 处理 | Opaque pass，从前到后排序 |
| `Mask` | 1 | `discard if alpha < cutoff` | Opaque pass (cutout)，从前到后排序 |
| `Blend` | 2 | 标准 Alpha 混合 | Transparent pass，从后到前排序 |

**Mask 模式的早期 discard**发生在片元着色器入口，避免透明测试失败的片元进入代价高昂的 BRDF 计算和纹理采样。Blend 模式则需要应用层在渲染前对实例进行距离排序，并通过独立渲染通道处理。Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L23-L35), [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L107-L110)

## 与相关系统的边界

材质系统的职责范围明确界定，与相邻系统形成清晰的接口边界：

- **[Bindless 描述符管理](https://github.com/1PercentSync/himalaya/blob/main/14-bindlessmiao-shu-fu-guan-li)**：材质系统消费 bindless 索引，但不管理纹理注册；DescriptorManager 负责实际的描述符集写入
- **[Render Graph 资源管理](https://github.com/1PercentSync/himalaya/blob/main/12-render-graphzi-yuan-guan-li)**：材质 SSBO 作为场景级资源，生命周期与场景绑定，不由 Render Graph 管理
- **[场景加载与 glTF 导入](https://github.com/1PercentSync/himalaya/blob/main/11-ying-yong-ceng-chang-jing-yu-jiao-hu)**：SceneLoader 解析 glTF 材质并构建 `GPUMaterialData`，MaterialSystem 仅负责 GPU 端存储

材质系统假设场景加载发生在 immediate command scope 内，因此 `upload_materials()` 要求调用者已处于 `Context::begin_immediate()` 作用域。这一约束确保了 SSBO 创建与上传的原子性，同时允许纹理终化阶段安全执行 GPU 命令提交。Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L120-L140), [material_system.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/material_system.cpp#L40-L75)