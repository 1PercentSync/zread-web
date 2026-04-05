Bindless描述符是Himalaya渲染架构的核心设计决策之一，它彻底改变了传统的Vulkan纹理绑定方式。传统方法需要在绘制时频繁绑定纹理描述符集，而Bindless模式通过在着色器中直接通过数组索引采样纹理，消除了CPU端的绑定开销，使材质系统能够无限制地访问任意数量的纹理，为延迟渲染和光线追踪奠定了基础。

## 核心设计原则

Himalaya的Bindless系统遵循三个关键原则：**最大纹理数量固定但可配置**（4096张2D纹理和256张立方体贴图）、**运行时动态注册/注销**（支持场景切换时的资源回收）、**Update-After-Bind支持**（允许在GPU使用期间安全更新描述符）。这套设计在全管线（光栅化、计算、光线追踪）中保持一致的访问语义，避免了复杂的描述符集切换逻辑。

### 三集合架构

系统采用三层描述符集合架构，每层服务于不同的数据访问模式。Set 0管理每帧更新的全局缓冲区（相机、灯光、材质实例数据），Set 1是核心的Bindless纹理数组（2D纹理和立方体贴图），Set 2专门用于渲染管线的中间产物（如GTAO结果、阴影图）。这种分层将静态纹理资源与动态帧数据分离，优化了描述符缓存效率。

```
┌─────────────────────────────────────────────────────────────────┐
│                     描述符集合架构 (3-Set Layout)                  │
├─────────────────────────────────────────────────────────────────┤
│  Set 0: 全局帧数据 (Per-Frame Global Data)                      │
│    Binding 0: GlobalUBO (Uniform Buffer)                        │
│    Binding 1: LightBuffer (SSBO - 方向光数组)                    │
│    Binding 2: MaterialBuffer (SSBO - 材质数据数组)               │
│    Binding 3: InstanceBuffer (SSBO - 实例变换矩阵)             │
│    Binding 4: TLAS (Acceleration Structure, RT only)            │
│    Binding 5: GeometryInfoBuffer (SSBO, RT only)               │
├─────────────────────────────────────────────────────────────────┤
│  Set 1: Bindless纹理数组 (Bindless Texture Arrays)                │
│    Binding 0: sampler2D textures[4096]                          │
│    Binding 1: samplerCube cubemaps[256]                         │
├─────────────────────────────────────────────────────────────────┤
│  Set 2: 渲染目标中间产物 (Render Target Intermediates)            │
│    Binding 0: rt_hdr_color         Binding 4: rt_contact_shadow   │
│    Binding 1: rt_depth_resolved    Binding 5: rt_shadow_map     │
│    Binding 2: rt_normal_resolved   Binding 6: rt_shadow_depth   │
│    Binding 3: rt_ao_texture        Binding 7: [reserved]        │
└─────────────────────────────────────────────────────────────────┘
```
Sources: [descriptors.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/descriptors.h#L1-L275), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L1-L190)

## Set 1: Bindless纹理数组实现

Set 1是整个系统的核心，包含两个独立的Bindless数组。2D纹理数组容量为4096张，使用`VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER`类型，配合`PARTIALLY_BOUND_BIT`和`UPDATE_AFTER_BIND_BIT`标志，允许数组中存在空槽位并在GPU使用期间动态更新。立方体贴图数组独立分配256个槽位，使用单独的binding点（binding 1），避免与2D纹理混淆。

### 动态槽位管理

系统实现了高效的槽位分配器，结合顺序分配与空闲列表复用。`next_bindless_index_`追踪下一个可用顺序槽位，`free_bindless_indices_`向量存储已释放的索引供复用。这种设计确保在场景切换时，已加载纹理的槽位可被新资源回收，避免数组碎片化。每个`BindlessIndex`结构体封装32位索引，提供`valid()`方法进行有效性检查，支持生成计数语义用于检测use-after-free。

```cpp
// C++端：BindlessIndex类型定义 (rhi/include/himalaya/rhi/types.h)
struct BindlessIndex {
    uint32_t index = UINT32_MAX;
    [[nodiscard]] bool valid() const { return index != UINT32_MAX; }
};

// C++端：纹理注册实现 (rhi/src/descriptors.cpp)
BindlessIndex DescriptorManager::register_texture(ImageHandle image, SamplerHandle sampler) {
    // 优先复用空闲槽位，否则顺序分配
    uint32_t slot;
    if (!free_bindless_indices_.empty()) {
        slot = free_bindless_indices_.back();
        free_bindless_indices_.pop_back();
    } else {
        assert(next_bindless_index_ < kMaxBindlessTextures);
        slot = next_bindless_index_++;
    }
    
    // 写入Set 1, Binding 0的指定数组元素
    const VkWriteDescriptorSet write{
        .dstSet = set1_set_,
        .dstBinding = 0,
        .dstArrayElement = slot,  // 数组索引
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
        .pImageInfo = &image_info,
    };
    vkUpdateDescriptorSets(context_->device, 1, &write, 0, nullptr);
    return {slot};
}
```
Sources: [types.h](https://github.com/1PercentSync/himalaya/blob/main/rhi/include/himalaya/rhi/types.h#L67-L73), [descriptors.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/descriptors.cpp#L88-L126)

### 着色器端访问

着色器通过GLSL的扩展特性访问Bindless数组，需要`GL_EXT_nonuniform_qualifier`扩展支持。材质数据结构（`GPUMaterialData`）存储Bindless索引而非纹理句柄，着色器根据材质索引从全局`MaterialBuffer`获取材质数据，再通过存储的索引访问`textures[]`或`cubemaps[]`数组。这种间接访问模式使材质能够引用任意已注册纹理，无需在绘制时重新绑定描述符集。

```glsl
// GLSL端：Bindless数组声明 (shaders/common/bindings.glsl)
#extension GL_EXT_nonuniform_qualifier : require

layout(set = 1, binding = 0) uniform sampler2D textures[];
layout(set = 1, binding = 1) uniform samplerCube cubemaps[];

// 材质数据结构中的Bindless索引
struct GPUMaterialData {
    uint base_color_tex;         // 指向 textures[] 的索引
    uint emissive_tex;
    uint metallic_roughness_tex;
    uint normal_tex;
    uint occlusion_tex;
    // ... 其他PBR参数
};

// 使用示例：前向渲染Pass采样材质纹理
void main() {
    GPUMaterialData mat = global.materials[frag_material_index];
    vec4 base_color = texture(textures[nonuniformEXT(mat.base_color_tex)], frag_uv0);
    vec3 normal_sample = texture(textures[nonuniformEXT(mat.normal_tex)], frag_uv0).rgb;
}
```
Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L172-L188), [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L1-L50)

## Set 0: 全局数据缓冲区

Set 0管理所有每帧更新的全局数据，采用分层绑定设计。Binding 0是`GlobalUBO`统一缓冲区，包含相机矩阵、屏幕尺寸、IBL参数等高频访问数据。Bindings 1-3是存储缓冲区（SSBO），分别容纳方向光数组、材质数据数组和实例变换数组。光线追踪扩展版本额外包含TLAS（binding 4）和几何信息缓冲区（binding 5）。

### 光线追踪扩展绑定

当启用光线追踪支持时，Set 0通过`PARTIALLY_BOUND_BIT`标志允许可选绑定。Binding 4的`accelerationStructureEXT`是光线追踪管线的核心加速结构，Binding 5的`GeometryInfoBuffer`为命中着色器提供顶点/索引缓冲区设备地址和材质偏移。这些绑定仅被RT着色器访问，传统光栅化管线忽略它们。

```cpp
// C++端：RT扩展绑定定义 (rhi/src/descriptors.cpp)
const VkDescriptorSetLayoutBinding set0_bindings[] = {
    // ... 基础绑定 0-3 ...
    {
        .binding = 4,
        .descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR,
        .descriptorCount = 1,
        .stageFlags = VK_SHADER_STAGE_RAYGEN_BIT_KHR | VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR,
    },
    {
        .binding = 5,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .descriptorCount = 1,
        .stageFlags = VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR | VK_SHADER_STAGE_ANY_HIT_BIT_KHR,
    },
};

// 标记为PARTIALLY_BOUND，允许某些帧不写入这些绑定
constexpr VkDescriptorBindingFlags set0_binding_flags[] = {
    0, 0, 0, 0,  // 基础绑定必须完整
    VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT,  // binding 4 (TLAS)
    VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT,  // binding 5 (GeometryInfo)
};
```
Sources: [descriptors.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/descriptors.cpp#L334-L363)

## Set 2: 渲染目标中间产物

Set 2专门用于Post-Processing和Compute Pass之间的数据传递，包含8个命名的`COMBINED_IMAGE_SAMPLER`绑定。与Set 1的动态数组不同，Set 2使用固定语义绑定（如`rt_ao_texture`固定为binding 3），Pass通过约定好的命名访问上游产物。所有绑定标记`PARTIALLY_BOUND_BIT`，允许管线配置省略未使用的绑定。

Set 2采用每帧双缓冲策略，因为某些产物（如TAA历史帧）需要帧间隔离。`update_render_target()`方法支持两种更新模式：全帧更新（初始化/窗口大小变化时）和单帧更新（Temporal Pass的动态历史帧）。这种设计使GTAO、Contact Shadows等效果能够安全地读写帧级中间产物。

```cpp
// C++端：Set 2绑定定义 (shaders/common/bindings.glsl)
layout(set = 2, binding = 3) uniform sampler2D rt_ao_texture;       // GTAO输出
layout(set = 2, binding = 4) uniform sampler2D rt_contact_shadow_mask;  // 接触阴影
layout(set = 2, binding = 5) uniform sampler2DArrayShadow rt_shadow_map;  // 级联阴影

// C++端：Set 2描述符布局创建 (rhi/src/descriptors.cpp)
for (uint32_t i = 0; i < kRenderTargetBindingCount; ++i) {
    set2_bindings[i] = {
        .binding = i,
        .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
        .descriptorCount = 1,
        .stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT | VK_SHADER_STAGE_COMPUTE_BIT,
    };
    set2_binding_flags_array[i] = VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT;
}
```
Sources: [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L177-L188), [descriptors.cpp](https://github.com/1PercentSync/himalaya/blob/main/rhi/src/descriptors.cpp#L444-L471)

## 上层系统集成

### 材质系统中的Bindless索引

`GPUMaterialData`结构体是连接材质系统与Bindless纹理的核心桥梁。每个材质实例存储5个纹理索引（基础颜色、法线、金属度-粗糙度、遮挡、自发光），使用`UINT32_MAX`表示未设置状态。`fill_material_defaults()`函数在场景加载时将未设置索引替换为默认纹理（白色、黑色或平面法线），确保着色器始终可以安全采样。

```cpp
// C++端：GPUMaterialData布局 (framework/include/himalaya/framework/material_system.h)
struct alignas(16) GPUMaterialData {
    glm::vec4 base_color_factor;      // offset  0
    glm::vec4 emissive_factor;        // offset 16
    float metallic_factor;            // offset 32
    float roughness_factor;         // offset 36
    float normal_scale;             // offset 40
    float occlusion_strength;       // offset 44
    uint32_t base_color_tex;        // offset 48 - Bindless索引
    uint32_t emissive_tex;          // offset 52 - Bindless索引
    uint32_t metallic_roughness_tex;  // offset 56 - Bindless索引
    uint32_t normal_tex;            // offset 60 - Bindless索引
    uint32_t occlusion_tex;         // offset 64 - Bindless索引
    // ... 总计80字节，std430对齐
};
static_assert(sizeof(GPUMaterialData) == 80);

// C++端：默认值填充逻辑 (framework/src/material_system.cpp)
void fill_material_defaults(GPUMaterialData &data, ...) {
    if (data.base_color_tex == UINT32_MAX) data.base_color_tex = default_white.index;
    if (data.normal_tex == UINT32_MAX) data.normal_tex = default_flat_normal.index;
    if (data.emissive_tex == UINT32_MAX) data.emissive_tex = default_black.index;
}
```
Sources: [material_system.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/material_system.h#L39-L57), [material_system.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/material_system.cpp#L18-L37)

### IBL系统的Bindless注册

IBL模块展示了立方体贴图Bindless数组的典型使用模式。加载HDR环境贴图后，系统生成4个GPU资源：天空盒立方体贴图、辐照度立方体贴图（Diffuse IBL）、预过滤立方体贴图（Specular IBL，带Mipmap链）、BRDF LUT（2D查找表）。前三个注册到Set 1 Binding 1的`cubemaps[]`数组，BRDF LUT注册到Binding 0的`textures[]`数组。

```cpp
// C++端：IBL Bindless注册 (framework/src/ibl.cpp)
void IBL::register_bindless() {
    // 立方体贴图 → Set 1 Binding 1
    skybox_cubemap_idx_ = dm_->register_cubemap(cubemap_, sampler_);
    irradiance_cubemap_idx_ = dm_->register_cubemap(irradiance_cubemap_, sampler_);
    prefiltered_cubemap_idx_ = dm_->register_cubemap(prefiltered_cubemap_, sampler_);
    
    // BRDF LUT (2D纹理) → Set 1 Binding 0
    brdf_lut_idx_ = dm_->register_texture(brdf_lut_, sampler_);
}

void IBL::destroy() const {
    // 注销顺序：先释放Bindless槽位，再销毁GPU资源
    if (skybox_cubemap_idx_.valid()) dm_->unregister_cubemap(skybox_cubemap_idx_);
    if (irradiance_cubemap_idx_.valid()) dm_->unregister_cubemap(irradiance_cubemap_idx_);
    // ... 其他注销操作
}
```
Sources: [ibl.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/ibl.cpp#L565-L599)

### 纹理加载与注册流水线

纹理系统的完整流程展示了Bindless注册在资源生命周期中的位置。`prepare_texture()`在CPU端执行图像解码、Mipmap生成和BC压缩，生成`PreparedTexture`。`finalize_texture()`在Immediate Command Scope中将压缩数据上传到GPU图像，然后调用`descriptor_manager.register_texture()`获取Bindless索引。这种分离设计允许纹理加载与压缩并行化，仅在最终阶段接触GPU状态。

```cpp
// C++端：纹理加载流水线 (framework/src/texture.cpp)
TextureResult finalize_texture(rhi::ResourceManager &resource_manager,
                               rhi::DescriptorManager &descriptor_manager,
                               const PreparedTexture &prepared,
                               rhi::SamplerHandle sampler,
                               const char *debug_name) {
    // 1. 创建GPU图像并上传压缩数据
    const auto image = resource_manager.create_image(desc, debug_name);
    resource_manager.upload_image_all_levels(image, prepared.data.data(), ...);
    
    // 2. 注册到Bindless数组，获取着色器访问索引
    const auto bindless_index = descriptor_manager.register_texture(image, sampler);
    
    return {image, bindless_index};  // 返回图像句柄和Bindless索引
}
```
Sources: [texture.cpp](https://github.com/1PercentSync/himalaya/blob/main/framework/src/texture.cpp#L400-L417)

## 性能考量与限制

### 硬件兼容性

Bindless描述符要求Vulkan 1.2+或`VK_EXT_descriptor_indexing`扩展，Himalaya通过`UPDATE_AFTER_BIND`和`PARTIALLY_BOUND`标志实现核心功能。现代GPU（NVIDIA RTX 20+、AMD RX 6000+、Intel Arc+）原生支持这些特性，但需要在设备创建时显式启用`descriptorIndexing`特性。

### 最佳实践

| 场景 | 推荐做法 | 原因 |
|------|----------|------|
| 材质纹理 | Set 1 Bindless数组 | 数千材质共享同一描述符集 |
| 动态纹理 (UI/视频) | 每帧更新的Staging纹理 | 避免频繁Bindless注册开销 |
| Post-Processing输入 | Set 2命名绑定 | 管线阶段间固定契约 |
| 每帧常量数据 | Set 0 UBO/SSBO | 与纹理分离，缓存友好 |
| 光线追踪实例数据 | Set 0 GeometryInfoBuffer | 命中着色器快速访问 |

### 容量限制

| 资源类型 | 最大数量 | 配置常量 |
|----------|----------|----------|
| 2D纹理 | 4096 | `kMaxBindlessTextures` |
| 立方体贴图 | 256 | `kMaxBindlessCubemaps` |
| Set 2渲染目标 | 8 | `kRenderTargetBindingCount` |

这些限制在编译期固定，可根据目标硬件调整。4096张2D纹理足以支持大型场景（如Sponza的100+材质，每个材质5张纹理，剩余空间用于IBL和后期处理资源）。

## 与相关系统的关联

Bindless描述符管理与系统的其他组件紧密协作。材质系统通过材质数据中的索引引用纹理，[材质系统架构](https://github.com/1PercentSync/himalaya/blob/main/13-cai-zhi-xi-tong-jia-gou)详细说明了这一机制。IBL系统使用立方体贴图数组存储环境光照数据，参见[BRDF与光照计算](https://github.com/1PercentSync/himalaya/blob/main/35-brdfyu-guang-zhao-ji-suan)了解光照计算细节。对于需要动态更新的渲染目标，[时域数据与Temporal Filtering](https://github.com/1PercentSync/himalaya/blob/main/15-shi-yu-shu-ju-yu-temporal-filtering)描述了Set 2的帧间管理策略。光线追踪着色器通过相同的Set 1访问材质纹理，[RT管线着色器组](https://github.com/1PercentSync/himalaya/blob/main/37-rtguan-xian-zhao-se-qi-zu)展示了这一一致性设计。