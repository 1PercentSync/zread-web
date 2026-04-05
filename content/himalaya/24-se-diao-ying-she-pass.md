色调映射Pass是Himalaya渲染管线的后处理阶段终章，负责将高动态范围（HDR）的渲染结果转换为可在标准显示器上呈现的有限动态范围（LDR）图像。作为后处理管线的最后一站，它直接决定最终画面的视觉表现。

**核心职责**
该Pass读取前向渲染或路径追踪阶段生成的HDR颜色缓冲，应用基于物理的曝光缩放，并通过ACES filmic曲线将超出的亮度范围压缩至$[0, 1]$区间。交换链使用sRGB格式，硬件自动将线性输出转换为gamma空间，无需额外计算。

**架构定位**
色调映射Pass位于后处理管线的终点，与其他Pass遵循相同的渲染图集成模式。它作为光栅化渲染路径和路径追踪参考视图共享的终点处理阶段，确保两种渲染模式在最终呈现上保持一致。

Sources: [tonemapping_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/tonemapping_pass.h#L1-L107), [tonemapping_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/tonemapping_pass.cpp#L1-L164)

## 算法原理

**ACES Filmic色调映射曲线**

Himalaya采用Narkowicz于2015年提出的ACES拟合曲线，这是业界广泛使用的参数化S曲线，其数学表达式为：

$$
\text{ACES}(x) = \text{clamp}\left(\frac{x(ax+b)}{x(cx+d)+e}, 0, 1\right)
$$

其中参数$a=2.51$, $b=0.03$, $c=2.43$, $d=0.59$, $e=0.14$。该曲线的特性在于：在低亮度区域保持近似线性响应以保留阴影细节，在中等亮度区域平滑过渡，在高亮度区域快速压缩以避免高光溢出，整体呈现令人愉悦的视觉S曲线。

**曝光控制**

曝光值存储于全局UBO的`camera_position_and_exposure.w`分量中。应用层通过EV（Exposure Value）参数进行直观控制，在填充UBO时转换为线性乘数：

```cpp
.exposure = std::pow(2.0f, ev_)
```

这遵循摄影中的标准曝光公式，每增加1 EV，曝光量翻倍。色调映射阶段先将HDR颜色乘以曝光系数，再应用ACES曲线，实现物理上可解释的亮度映射。

**直传模式**

调试渲染模式（debug render mode）支持多种可视化选项。当模式设置为`DEBUG_MODE_PASSTHROUGH_START`（值为4）及以上时，色调映射Pass跳过曝光调整和ACES处理，直接输出原始HDR值。这使开发者能够检视法线、金属度、粗糙度、AO等中间属性的原始数值，便于材质调试。

Sources: [tonemapping.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/tonemapping.frag#L20-L47), [application.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/application.cpp#L429-L544)

## 架构设计

**全屏三角形渲染**

色调映射Pass采用全屏后处理技术，不绑定任何顶点缓冲区。顶点着色器通过`gl_VertexIndex`生成覆盖整个视口的三角形，UV坐标推导自顶点索引：

```glsl
out_uv = vec2((gl_VertexIndex << 1) & 2, gl_VertexIndex & 2);
gl_Position = vec4(out_uv * 2.0 - 1.0, 0.0, 1.0);
```

这种经典的"大三角形"技术避免了传统四边形的对角线问题，确保像素中心精确对齐纹理采样点。光栅化后，UV范围$[0,2] \times [0,2]$被视口裁剪至$[0,1] \times [0,1]$的有效区域。

**描述符集绑定**

该Pass使用三层描述符集架构：
- **Set 0**：全局UBO（曝光值）、光源缓冲、材质缓冲、实例缓冲
- **Set 1**：Bindless纹理数组（系统级资源）
- **Set 2**：渲染目标中间产物，色调映射Pass读取`rt_hdr_color`（binding 0）

管线创建时指定`swapchain_format`作为颜色附件格式，深度附件格式设为`VK_FORMAT_UNDEFINED`表明无需深度测试。多采样数固定为1，因为该Pass处理的是已解析的HDR结果而非原始MSAA数据。

**动态状态配置**

录制阶段启用以下动态管线状态：
- 视口设置为交换链图像尺寸，原点为$(0,0)$无需Y轴翻转（后处理阶段纹理采样不涉及3D坐标系）
- 裁剪矩形覆盖整幅图像
- 禁用背面剔除（`VK_CULL_MODE_NONE`）
- 禁用深度测试与深度写入

Sources: [fullscreen.vert](https://github.com/1PercentSync/himalaya/blob/main/shaders/fullscreen.vert#L1-L24), [tonemapping_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/tonemapping_pass.cpp#L70-L160), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L177-L189)

## 着色器实现

**片元着色器流程**

色调映射片元着色器的执行流程简洁而明确。首先通过UV坐标采样HDR颜色缓冲，随后根据调试模式进行分支判断，正常渲染路径下提取全局UBO中的曝光系数，执行乘法曝光调整，最后通过ACES曲线输出线性LDR颜色。

硬件sRGB转换机制值得注意：片元着色器输出线性颜色，而交换链图像使用`VK_FORMAT_B8G8R8A8_SRGB`或同类格式，GPU的ROP单元自动完成线性到sRGB的gamma编码。这种设计避免了在着色器中进行代价高昂的幂函数计算。

**资源依赖声明**

在RenderGraph层面，该Pass显式声明资源使用模式：
- `hdr_color`：读取访问，片元着色器阶段
- `swapchain`：写入访问，颜色附件阶段

这种声明使渲染图能够正确推导资源状态转换屏障，确保HDR缓冲在采样前处于`SHADER_READ_OPTIMAL`布局，交换链图像在写入前处于`COLOR_ATTACHMENT_OPTIMAL`布局。

Sources: [tonemapping.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/tonemapping.frag#L1-L48), [tonemapping_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/tonemapping_pass.cpp#L91-L106)

## 集成与使用

**光栅化路径集成**

在光栅化渲染路径中，色调映射Pass作为渲染图构建的最终环节被调用。前向渲染Pass完成场景绘制后，HDR缓冲已就绪。渲染器按顺序记录阴影Pass、深度预Pass、天空盒Pass、前向渲染Pass，最后调用色调映射Pass将结果呈现至屏幕。

**路径追踪路径集成**

路径追踪参考视图同样以色调映射Pass作为终点。路径追踪的compute shader将结果写入HDR缓冲后，色调映射Pass以完全相同的方式处理输出，确保两种渲染模式在视觉呈现上无缝切换。

**运行时管线重建**

支持运行时着色器热重载是该Pass的重要特性。`rebuild_pipelines()`方法触发着色器重新编译：若编译失败，保留原有管线确保渲染不中断；若编译成功，先销毁旧管线再创建新管线。这要求调用者在重建前确保GPU空闲（`vkQueueWaitIdle`），避免正在执行的帧引用被销毁的资源。

Sources: [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L1-L80), [renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp), [tonemapping_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/tonemapping_pass.h#L60-L72)

## 相关页面

色调映射Pass是后处理管线的终点，其输入来自前向渲染或路径追踪阶段。如需了解HDR内容的生成过程，请参阅：

- [前向渲染Pass](https://github.com/1PercentSync/himalaya/blob/main/18-qian-xiang-xuan-ran-pass) — 生成色调映射的HDR输入
- [路径追踪参考视图](https://github.com/1PercentSync/himalaya/blob/main/26-lu-jing-zhui-zong-can-kao-shi-tu) — 替代性HDR内容生成路径
- [Render Graph资源管理](https://github.com/1PercentSync/himalaya/blob/main/12-render-graphzi-yuan-guan-li) — 理解资源依赖声明机制
- [后处理管线架构](https://github.com/1PercentSync/himalaya/blob/main/10-xuan-ran-passceng-xiao-guo-shi-xian) — 色调映射在Pass层的位置