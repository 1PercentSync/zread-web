Himalaya渲染器采用基于物理的渲染（PBR）管线，所有光照计算均遵循能量守恒原则。本文档详细阐述BRDF核心组件、直接光照实现、IBL环境光照系统，以及路径追踪中的高级采样技术。

## BRDF理论基础

BRDF（双向反射分布函数）描述了光线在表面上的散射行为。Himalaya实现标准的**Cook-Torrance微表面模型**，该模型将反射分解为漫反射（Diffuse）和镜面反射（Specular）两个部分：

$$f_{pbr} = (1 - F) \cdot \frac{\rho_{diff}}{\pi} + F \cdot \frac{D \cdot V}{\pi}$$

其中 **D** 是法线分布函数（NDF），**V** 是可见性函数（Geometry），**F** 是菲涅尔项。这三项完全解耦，便于独立优化和调试。

Sources: [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L1-L75)

## 核心BRDF函数库

`brdf.glsl` 提供三大纯函数组件，不依赖任何场景数据，可被前向渲染和路径追踪管线复用。

### D_GGX - 法线分布函数

GGX/Trowbridge-Reitz分布模拟微表面的朝向分布，相比传统的Blinn-Phong，它能更好地表现真实材质的高光拖尾效果：

```glsl
float D_GGX(float NdotH, float roughness) {
    float a  = roughness * roughness;
    float a2 = a * a;
    float d  = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}
```

代码中先将线性粗糙度平方转换为 **α = roughness²**（GLTF标准），再计算归一化的分布值。`NdotH` 是法线与半向量的点积，必须在调用前完成钳制（clamping）。

Sources: [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L22-L32)

### V_SmithGGX - 可见性函数

采用Heitz 2014年提出的**高度相关Smith模型**（Height-Correlated Smith），相比传统的分离式Smith G项，它在粗糙表面上能提供更准确的几何衰减：

```glsl
float V_SmithGGX(float NdotV, float NdotL, float roughness) {
    float a  = roughness * roughness;
    float a2 = a * a;
    float ggxV = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
    float ggxL = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
    return 0.5 / max(ggxV + ggxL, EPSILON);
}
```

该实现将 `G / (4 · NdotV · NdotL)` 合并为单一函数，返回可直接参与BRDF乘法的可见性值，避免了调用端的额外除法运算。

Sources: [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L34-L52)

### F_Schlick - 菲涅尔近似

Schlick近似以低成本模拟电介质和导体的菲涅尔效应——材质在掠射角趋向完全反射：

```glsl
vec3 F_Schlick(float VdotH, vec3 F0) {
    float f = pow(1.0 - VdotH, 5.0);
    return F0 + (1.0 - F0) * f;
}
```

`F0` 是垂直入射时的反射率（电介质约为0.04，金属为基色），`VdotH` 是视线与半向量的点积。

Sources: [brdf.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/brdf.glsl#L54-L64)

## 数学常数

BRDF计算依赖的高精度数学常数统一在 `constants.glsl` 中定义：

| 常量 | 值 | 用途 |
|------|-----|------|
| PI | 3.141592653589793 | 半球积分归一化 |
| TWO_PI | 6.283185... | 球面积分、方位角采样 |
| INV_PI | 0.318309... | Lambert漫反射归一化 |
| EPSILON | 0.0001 | 除零保护 |

Sources: [constants.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/constants.glsl#L1-L16)

## 直接光照实现

### 光源模型

前向渲染Pass（[Forward Pass](https://github.com/1PercentSync/himalaya/blob/main/18-qian-xiang-xuan-ran-pass)）支持方向光（Directional Light），每个光源包含方向、颜色和强度参数。光照计算在切空间完成，流程如下：

```glsl
// 半向量与点积计算
vec3 H = normalize(V + L);
float NdotL = max(dot(N, L), 0.0);
float NdotH = max(dot(N, H), 0.0);
float VdotH = max(dot(V, H), 0.0);

// BRDF组装
float D   = D_GGX(NdotH, roughness);
float Vis = V_SmithGGX(NdotV, NdotL, roughness);
vec3  F   = F_Schlick(VdotH, F0);

// 漫反射 + 镜面反射
vec3 specular = D * Vis * F * radiance;
vec3 diffuse  = (1.0 - F) * diffuse_color * INV_PI * radiance;
```

`radiance` 已包含光源颜色、强度和NdotL余弦衰减。镜面项直接应用 `D * Vis * F` 的BRDF乘积，漫反射项使用 `(1-F)` 保证能量守恒——镜面反射越强，漫反射越弱。

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L200-L232)

### 阴影衰减

直接光照支持两级阴影衰减：级联阴影贴图（Cascaded Shadow Maps）提供远距离投影，接触阴影（Contact Shadows）处理近距离细节。两者通过独立的Feature Flag控制，可单独启用或禁用：

```glsl
// 级联阴影（每光源可选）
radiance *= blend_cascade_shadow(frag_world_pos, N, view_depth);

// 接触阴影（仅主光源）
if (i == 0u) {
    radiance *= contact_shadow;
}
```

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L225-L236)

## IBL环境光照

IBL（Image-Based Lighting）系统基于**Split-Sum Approximation**将计算拆分为三个独立部分：漫反射辐照度图、预过滤镜面环境图、BRDF积分LUT。这种分离使得运行时仅需几次纹理采样即可完成复杂的环境光照计算。

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L238-L250)

### 漫反射辐照度

漫反射计算使用余弦加权半球卷积，将HDR环境贴图转换为低频辐照度立方体贴图：

```glsl
// 球面积分：L(ω) * cos(θ) * sin(θ)
for (float phi = 0.0; phi < TWO_PI; phi += DELTA) {
    for (float theta = 0.0; theta < HALF_PI; theta += DELTA) {
        irradiance += texture(environment, sample_dir) * cos(theta) * sin(theta);
    }
}
irradiance = PI * irradiance / sample_count;
```

积分采用均匀的球坐标步进，包含 `sin(θ)` 雅可比项和 `cos(θ)` Lambert权重。Firefly拒绝机制（`MAX_RADIANCE = 1000.0`）防止极端HDR值（如太阳）主导积分结果。

Sources: [irradiance.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/irradiance.comp#L1-L72)

### 预过滤镜面环境

镜面环境贴图通过重要性采样GGX分布进行预过滤，每个mip级别对应不同的粗糙度。粗糙度为0时近似镜面反射，高粗糙度产生模糊反射：

```glsl
// 重要性采样GGX半向量
vec3 H = importance_sample_ggx(xi, N, roughness);
vec3 L = normalize(2.0 * dot(V, H) * H - V);

// PDF-based mip选择实现样本足迹匹配
float pdf = D * NdotH / (4.0 * HdotV + EPSILON);
float mip_level = 0.5 * log2(sa_sample / sa_texel);
```

计算中利用GGX的PDF（概率密度函数）推导合适的mip级别，确保采样分辨率与环境贴图纹理分辨率匹配，避免走样。

Sources: [prefilter.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/prefilter.comp#L1-L80)

### BRDF积分LUT

2D查找表以 `(NdotV, roughness)` 为输入，预计算镜面BRDF的积分部分：

```glsl
// Scale/Bias形式：F_integrated = F0 * scale + bias
for (uint i = 0u; i < SAMPLE_COUNT; ++i) {
    scale += (1.0 - Fc) * G_Vis;
    bias  += Fc * G_Vis;
}
```

`scale` 和 `bias` 分别对应菲涅尔项的 `F0` 系数和偏移量。该表与环境无关，可全局共享。

Sources: [brdf_lut.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/brdf_lut.comp#L1-L92)

## 路径追踪BRDF采样

路径追踪管线（[路径追踪参考视图](https://github.com/1PercentSync/himalaya/blob/main/26-lu-jing-zhui-zong-can-kao-shi-tu)）需要能够**采样**（而不仅是求值）BRDF，以生成无偏的次级光线方向。

### 多波瓣选择

材质包含漫反射和镜面两个波瓣，通过Fresnel亮度决定选择概率：

```glsl
float specular_probability(float NdotV, vec3 F0) {
    vec3 F = F_Schlick(NdotV, F0);
    float spec_weight = F.r * 0.2126 + F.g * 0.7152 + F.b * 0.0722;
    return clamp(spec_weight, 0.01, 0.99);
}
```

概率钳制在[0.01, 0.99]区间防止除零。

Sources: [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L170-L182)

### VNDF重要性采样

镜面波瓣采用Heitz 2018年的**可见法线分布函数（VNDF）**采样技术，相比传统采样NDF的方法，它能显著降低粗糙表面上的方差：

```glsl
vec3 sample_ggx_vndf(vec3 Ve, float roughness, vec2 xi) {
    float alpha = roughness * roughness;
    vec3 Vh = normalize(vec3(alpha * Ve.x, alpha * Ve.y, Ve.z));
    
    // 均匀圆盘采样 + 投影到半球
    vec3 Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1*t1 - t2*t2)) * Vh;
    
    return normalize(vec3(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}
```

VNDF采样考虑了遮蔽函数，仅采样可见微表面，样本效率更高。

Sources: [pt_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/pt_common.glsl#L260-L293)

### 波 throughput计算

镜面波瓣的throughput计算使用 `BRDF * cos(θ) / PDF / p_spec`：

```glsl
float D   = D_GGX(NdotH, roughness);
float Vis = V_SmithGGX(NdotV, NdotL, roughness);
vec3  F   = F_Schlick(VdotH, F0);
float pdf = pdf_ggx_vndf(NdotH, NdotV, VdotH, roughness);

throughput_update = (D * Vis * F * NdotL) / max(pdf * p_spec, 1e-7);
```

漫反射波瓣使用余弦加权采样，PDF与 `cos(θ)/π` 抵消，throughput简化为 `diffuse_color / (1 - p_spec)`。

Sources: [closesthit.rchit](https://github.com/1PercentSync/himalaya/blob/main/shaders/rt/closesthit.rchit#L1-L227)

## 采样工具函数

IBL和路径追踪共享一套采样基础设施，定义在 `ibl_common.glsl`：

### Hammersley序列

低差异序列用于蒙特卡洛积分，相比随机采样具有更快的收敛速度：

```glsl
vec2 hammersley(uint i, uint n) {
    return vec2(float(i) / float(n), radical_inverse_vdc(i));
}
```

`radical_inverse_vdc` 通过位操作实现Van der Corput序列，生成在[0,1)区间均匀分布的样本。

Sources: [ibl_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/ibl_common.glsl#L32-L55)

### GGX重要性采样

将Hammersley样本转换为符合GGX分布的半向量：

```glsl
vec3 importance_sample_ggx(vec2 xi, vec3 N, float roughness) {
    float phi = TWO_PI * xi.x;
    float cos_theta = sqrt((1.0 - xi.y) / (1.0 + (a*a - 1.0) * xi.y));
    // ... 切线空间转换
}
```

该方法通过逆变换采样（Inverse Transform Sampling）将均匀随机数映射到GGX分布的球坐标。

Sources: [ibl_common.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/ibl/ibl_common.glsl#L57-L87)

## 环境光遮蔽集成

BRDF结果与环境光遮蔽（AO）结合时，需处理漫反射和镜面反射的不同遮蔽特性：

### 多反弹颜色补偿

原始AO在高反射率表面上会产生过度暗化，Jimenez 2016的多反弹补偿通过多项式拟合修正：

```glsl
vec3 multi_bounce_ao(float ao, vec3 albedo) {
    vec3 a = 2.0404 * albedo - 0.3324;
    vec3 b = -4.7951 * albedo + 0.6417;
    vec3 c = 2.7552 * albedo + 0.6903;
    return max(vec3(ao), ((ao * a + b) * ao + c) * ao);
}
```

返回的每通道遮蔽因子始终大于等于原始AO值。

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L28-L42)

### 镜面遮蔽（Specular Occlusion）

GTSO（Geometric Term Specular Occlusion）通过可见性锥和镜面锥的交集计算镜面遮蔽：

```glsl
float gtso_specular_occlusion(vec3 bent_normal, vec3 R, float ao, float roughness) {
    float alpha_v = acos(sqrt(1.0 - ao));  // 可见性锥半角
    float alpha_s = max(acos(pow(0.01, 0.5 * roughness * roughness)), 0.01);  // 镜面锥半角
    float beta = acos(clamp(dot(bent_normal, R), -1.0, 1.0));  // 锥轴夹角
    
    return mix(smoothstep(0.0, 1.0, (alpha_v - beta) / alpha_s), 1.0, ao * ao);
}
```

其中 `ao²` 项补偿掠射角伪影——当AO接近1.0时，锥体交模型会将半球边界误判为遮蔽边缘。

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L55-L78)

## 调试渲染模式

前向Pass支持多种调试模式，用于可视化光照计算的中间结果：

| 模式 | 输出 | 用途 |
|------|------|------|
| DEBUG_MODE_NORMAL | N * 0.5 + 0.5 | 验证法线映射 |
| DEBUG_MODE_METALLIC | 灰度金属度 | 检查材质参数 |
| DEBUG_MODE_ROUGHNESS | 灰度粗糙度 | 检查材质参数 |
| DEBUG_MODE_AO | 组合AO | 验证遮蔽效果 |
| DEBUG_MODE_DIFFUSE_ONLY | 仅漫反射 | 分离BRDF分量 |
| DEBUG_MODE_SPECULAR_ONLY | 仅镜面反射 | 分离BRDF分量 |
| DEBUG_MODE_IBL_ONLY | 仅环境光照 | 验证IBL集成 |

调试模式在光照计算之前提前返回，跳过完整的BRDF组装。

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L84-L140)

## 延伸阅读

- [前向渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/18-qian-xiang-xuan-ran-pass) - BRDF在实际渲染Pass中的应用
- [路径追踪参考视图](https://github.com/1PercentSync/himalaya/blob/main/26-lu-jing-zhui-zong-can-kao-shi-tu) - 蒙特卡洛BRDF采样实现
- [GTAO算法实现](https://github.com/1PercentSync/himalaya/blob/main/22-gtaosuan-fa-shi-xian) - 环境光遮蔽计算
- [公共工具函数](https://github.com/1PercentSync/himalaya/blob/main/36-gong-gong-gong-ju-han-shu) - 法线映射、坐标变换等辅助功能