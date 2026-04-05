The **GTAO pipeline** is a three-stage compute-post-processing system that produces high-quality screen-space ambient occlusion from a depth buffer and world-space normal buffer. Ground-Truth Ambient Occlusion (Jimenez et al. 2016) replaces classic ray-marched SSAO with an analytic horizon-search approach: for each pixel, the shader sweeps multiple directions across the depth buffer, finds the occlusion horizon on each side, and integrates the cosine-weighted visibility integral in closed form. The raw output — noisy due to limited sample counts — then passes through a 5×5 edge-preserving bilateral blur and a reprojection-based temporal accumulator with three-layer rejection, producing a temporally stable AO signal with a side product: a **bent normal** vector representing the mean unoccluded direction per pixel.

The pipeline's three passes are orchestrated by the renderer in strict sequential order — GTAO → Spatial → Temporal — within the render graph, which automatically inserts memory barriers between them. The final `ao_filtered` image is consumed by the [Forward Pass](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao) for diffuse AO and specular occlusion (GTSO cone intersection), and also serves as temporal history for the next frame.

Sources: [gtao_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L1-L176), [ao_spatial_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_spatial_pass.cpp#L1-L164), [ao_temporal_pass.cpp](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L1-L221), [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L321-L324)

## Pipeline Architecture and Data Flow

The AO pipeline operates entirely in compute shaders dispatched at full resolution (one 8×8 workgroup thread per pixel), reading from the resolved depth and normal buffers produced by the [Depth Prepass](https://github.com/1PercentSync/himalaya/blob/main/16-depth-prepass-z-fill-for-zero-overdraw-forward-rendering). No shared memory is used — each thread independently processes its pixel.

```mermaid
flowchart LR
    subgraph Inputs
        D[Depth Buffer<br/>D32Sfloat]
        N[Normal Buffer<br/>R10G10B10A2]
        DP[Depth Prev<br/>D32Sfloat]
        AH[AO History<br/>RGBA8]
    end

    subgraph Pass 1 — GTAO
        G[GTAO<br/>Compute 8×8<br/>Horizon Search +<br/>Analytic Integration]
    end

    subgraph Pass 2 — Spatial
        S[Bilateral Blur<br/>Compute 8×8<br/>5×5 Edge-Aware<br/>Gaussian + Depth]
    end

    subgraph Pass 3 — Temporal
        T[Temporal Filter<br/>Compute 8×8<br/>Reprojection +<br/>3-Layer Rejection]
    end

    subgraph Outputs
        AF[ao_filtered<br/>RGBA8]
        FWD[Forward Pass<br/>Diffuse AO + GTSO]
    end

    D --> G
    N --> G
    G -->|ao_noisy<br/>RGBA8| S
    D --> S
    S -->|ao_blurred<br/>RGBA8| T
    D --> T
    DP --> T
    AH --> T
    T -->|ao_filtered<br/>RGBA8| AF
    AF -->|Next frame<br/>history| AH
    AF --> FWD
```

The render graph manages four intermediate resources — `ao_noisy`, `ao_blurred`, `ao_filtered`, and `ao_history` — all in `R8G8B8A8Unorm` format. The `ao_filtered` image is created with history support (`true` parameter to `create_managed_image`), enabling the render graph to retain the previous frame's result for temporal reprojection. Each pass declares its resource accesses (read/write) to the render graph, which automatically inserts layout transitions and memory barriers between passes.

Sources: [renderer_init.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_init.cpp#L90-L127), [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L260-L290), [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L60-L72)

## GTAO Compute Shader — Horizon Search and Analytic Integration

The `gtao.comp` shader implements the core GTAO algorithm. For each pixel, it reconstructs the view-space position from depth, rotates the world-space normal into view-space, then performs a structured horizon search across multiple directions in screen-space.

### View-Space Reconstruction and Noise

The shader reconstructs view-space position from the depth buffer using `inv_projection`, accounting for the Y-flipped viewport used by scene passes (negative viewport height convention). The world-space normal stored in `R10G10B10A2_UNORM` (encoded as `n * 0.5 + 0.5`) is decoded and rotated to view-space via the upper-left 3×3 of the view matrix.

Temporal noise decorrelation uses **interleaved gradient noise** (Jorge Jimenez) modulated by the golden ratio fractional part, producing quasi-random per-pixel offsets that vary smoothly across frames:

```
base_noise = fract(IGN(pixel) + frame_index % 64 * φ)
dir_noise  = base_noise           // direction jitter
step_noise = fract(base_noise * 0.7 + 0.15)  // step jitter within direction
```

This decorrelation is critical for temporal accumulation — diverse noise patterns across frames allow the temporal filter to effectively multiply the sample count.

Sources: [gtao.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L1-L103), [noise.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/noise.glsl#L19-L36), [normal.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/normal.glsl#L72-L74)

### Horizon Search with Distance Falloff

For each of `directions` search directions, the shader projects a tangent vector in screen-space and marches `steps_per_dir` samples along both positive and negative directions. Sample positions follow a **quadratic power curve** (`t = linear_t²`) that clusters samples near the pixel center where crevice and corner detail matters most, with sparse samples at the periphery for large-scale occlusion.

The distance falloff uses a flat-inner/steep-outer profile with `kFalloffRange = 0.615` (matching XeGTAO's auto-tuned optimal): samples within `radius × (1 − 0.615)` receive full weight, beyond which weight linearly decays to zero at the radius boundary. This preserves near-surface detail while aggressively cutting distant contributions.

| Parameter | Description | Typical Range |
|-----------|-------------|---------------|
| `radius` | World-space sampling radius (meters) | 0.1 – 5.0 |
| `directions` | Number of search directions | 2 / 4 / 8 |
| `steps_per_dir` | Ray march steps per direction | 2 / 4 / 8 |
| `thin_compensation` | Blend toward tangent plane (0 = off) | 0.0 – 0.7 |
| `intensity` | AO power curve exponent | 0.5 – 3.0 |
| `frame_index` | Frame counter for temporal noise | monotonically increasing |

Sources: [gtao.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L155-L181), [GTAOPushConstants](https://github.com/1PercentSync/himalaya/blob/main/passes/src/gtao_pass.cpp#L24-L31), [AOConfig](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L224-L245)

### Analytic Integration and Bent Normal

The key insight of GTAO is that once the horizon angles `h1` and `h2` (positive and negative sides) are found for a given direction, the **cosine-weighted visibility integral** can be evaluated analytically rather than stochastically:

```
inner_integral(h, n) = 0.25 × (−cos(2h − n) + cos(n) + 2h × sin(n))
slice_visibility(h1, h2, n) = inner_integral(h1, n) + inner_integral(h2, −n)
```

The **bent normal** computation follows Algorithm 2 from the GTAO paper — the per-slice cosine-weighted mean unoccluded direction. All compound-angle trigonometric expressions are expanded using identities (triple-angle: `sin(3x) = 3s − 4s³`, sum/difference products) so the entire bent normal integral requires **zero additional** `sin()`, `cos()`, or `acos()` calls beyond what the AO integral already computed. This is a significant optimization on GPU architectures where transcendental functions are expensive.

The final output is packed as `RGBA8` where RGB = bent normal (encoded as `n × 0.5 + 0.5`) and A = diffuse AO value. If the accumulated bent normal is degenerate (near-zero length), it falls back to the surface normal.

Sources: [gtao.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L102-L120), [gtao.comp bent normal](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L237-L275), [gtao.comp output](https://github.com/1PercentSync/himalaya/blob/main/shaders/gtao.comp#L278-L285)

## Spatial Denoising — 5×5 Edge-Aware Bilateral Blur

The raw GTAO output is noisy at low sample counts (e.g., 4 directions × 4 steps = 16 samples per pixel). The `ao_spatial.comp` shader applies a **5×5 bilateral blur** that combines Gaussian spatial weights (σ = 1.5) with depth-based edge weights to prevent AO bleeding across geometric boundaries.

### Path-Accumulated Edge Weights

The critical design decision is the edge weight computation. Rather than computing a simple pairwise weight between the center pixel and each tap, the shader accumulates edge weights **along a grid path** from center to target — horizontal leg first, then vertical leg at the target column. Each leg multiplies the adjacent-pixel depth edge weights encountered along the way.

This path-accumulation approach prevents "tunneling": even if two pixels share identical depths, an intervening depth discontinuity (a thin wall, a one-pixel edge between two surfaces at the same distance) drives the accumulated path weight to zero. A naïve bilateral filter would blur across such boundaries; the path approach correctly blocks them.

The edge weight function uses **relative depth comparison** for scene-scale independence:

```
depth_edge_weight(z1, z2) = clamp(1 − |z1 − z2| / (max(z1, z2) × 0.05), 0, 1)
```

Linearized depth values (via `projection[3][2] / (d + projection[2][2])`) ensure uniform rejection sensitivity at all camera distances, unlike raw Reverse-Z values which compress non-linearly.

Sources: [ao_spatial.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_spatial.comp#L1-L157), [depth.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/depth.glsl#L21-L23)

## Temporal Denoising — Reprojection with Three-Layer Rejection

The `ao_temporal.comp` shader performs **exponential moving average** temporal accumulation by reprojecting the current pixel back to the previous frame's screen-space, sampling the history buffer, and blending with the spatially denoised current-frame result. The blend factor (`temporal_blend`) is a runtime parameter (0.0–0.98), set to 0.0 on the first frame or when history is invalidated (resize, first frame).

### Reprojection Pipeline

The reprojection follows: screen UV + depth → NDC → clip → world space (via `inv_view_projection`) → previous frame clip (via `prev_view_projection`) → previous NDC → previous UV. The Y-flip conventions are handled symmetrically in both directions.

### Three-Layer Rejection

History rejection prevents ghosting artifacts from temporal accumulation of stale data. The shader applies three progressively stricter tests:

| Layer | Test | Rejection Condition |
|-------|------|---------------------|
| **1 — UV Validity** | Is reprojected UV within [0,1]? | Off-screen pixels reject entirely |
| **2 — Depth Consistency** | Linearized depth comparison | `\|expected − stored\| / expected > 5%` |
| **3 — Neighborhood Clamp** | 3×3 min/max from current frame | History AO clamped to `[min, max]` range |

Layers 1 and 2 produce **hard rejection** (history discarded entirely, output = current frame). Layer 3 produces **soft clamping** — the history AO value is retained but clamped into the 3×3 neighborhood min/max range, which handles slow-moving disocclusions gracefully.

**Bent normal (RGB) is NOT neighborhood-clamped** — min/max of encoded direction vectors has no physical meaning. The bent normal shares the rejection flag (zero-blended on hard rejection) but otherwise blends directly.

After blending, the output bent normal is decoded, re-normalized, and re-encoded to prevent drift from unit length caused by averaging encoded values.

Sources: [ao_temporal.comp](https://github.com/1PercentSync/himalaya/blob/main/shaders/ao_temporal.comp#L1-L181), [AOTemporalPass::record](https://github.com/1PercentSync/himalaya/blob/main/passes/src/ao_temporal_pass.cpp#L139-L219), [frame_context.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/frame_context.h#L136-L137)

## Pass Infrastructure — Descriptor Layout and Dispatch Pattern

All three passes share an identical architectural pattern: each owns a Vulkan compute pipeline, a custom **Set 3 push descriptor layout** for per-dispatch I/O, and binds the global Sets 0–2 (per-frame uniforms, bindless textures, render targets). Passes are registered with the render graph via `record()`, which declares resource usage (read/write/compute stage) and provides a lambda callback for command buffer recording.

| Pass | Set 3 Bindings | Push Constants | Workgroup |
|------|---------------|---------------|-----------|
| GTAO | `binding 0`: `storage_image` (ao_noisy) | `GTAOPushConstants` (24 bytes) | 8×8 |
| AO Spatial | `binding 0`: `storage_image` (ao_blurred), `binding 1`: `combined_image_sampler` (ao_noisy) | None | 8×8 |
| AO Temporal | `binding 0`: `storage_image` (ao_filtered), `binding 1`: `sampler` (ao_blurred), `binding 2`: `sampler` (ao_history), `binding 3`: `sampler` (depth_prev) | `AOTemporalPushConstants` (4 bytes) | 8×8 |

The dispatch dimensions are computed as `ceil(width / 8) × ceil(height / 8)`, with the shader's bounds check (`pixel >= size → return`) handling the fringe case where the resolution isn't a multiple of 8. The temporal pass also reads `depth` from Set 2 (binding 1) for reprojection, and the render graph updates the Set 2 binding 3 (`rt_ao_texture`) each frame with the `ao_filtered` backing image so the [Forward Pass](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao) can sample it.

Sources: [gtao_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/gtao_pass.h#L38-L100), [ao_spatial_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/ao_spatial_pass.h#L39-L108), [ao_temporal_pass.h](https://github.com/1PercentSync/himalaya/blob/main/passes/include/himalaya/passes/ao_temporal_pass.h#L40-L109), [renderer_rasterization.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/renderer_rasterization.cpp#L270-L278)

## Consumption in the Forward Pass

The [Forward Pass](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao) samples `rt_ao_texture` (Set 2, binding 3 — the temporally filtered `ao_filtered` image) to extract both diffuse AO (A channel) and the bent normal (RGB, decoded and transformed back to world-space). Two specular occlusion modes are available at runtime via `ao_so_mode`:

- **Lagarde approximation** (`AO_SO_LAGARDE`): Estimates specular occlusion from diffuse AO, view angle, and roughness — no bent normal required. A useful baseline comparison.
- **GTSO cone intersection** (`AO_SO_GTSO`): Computes the overlap between a visibility cone (derived from bent normal + AO) and a specular lobe cone (reflection direction + roughness), with `ao²` grazing-angle compensation to eliminate false darkening.

Diffuse AO is combined with material-baked occlusion (`occlusion_tex × occlusion_strength`) and then passed through **multi-bounce AO color compensation** (Jimenez 2016), which prevents over-darkening on light-colored surfaces by modeling inter-bounce light scattering as a per-channel polynomial correction.

Sources: [forward.frag](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L253-L300), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L62-L65), [scene_data.h](https://github.com/1PercentSync/himalaya/blob/main/framework/include/himalaya/framework/scene_data.h#L315)

## Runtime Configuration and Debug Visualization

All AO parameters are exposed through the Debug UI for real-time tuning. The `AOConfig` struct lives in application space and is passed to passes via `FrameContext::ao_config`, which is dereferenced into push constants each frame. The render graph's history validity tracking (`is_history_valid()`) automatically resets temporal accumulation on first frame and resize events.

| Control | Field | Range | Notes |
|---------|-------|-------|-------|
| Radius | `radius` | 0.1 – 5.0 m | World-space sampling extent |
| Directions | `directions` | 2 / 4 / 8 | Quality/performance tradeoff |
| Steps/Dir | `steps_per_dir` | 2 / 4 / 8 | Per-direction sample density |
| Thin Compensation | `thin_compensation` | 0.0 – 0.7 | XeGTAO quality at 0.7 |
| Intensity | `intensity` | 0.5 – 3.0 | Power curve exponent |
| Temporal Blend | `temporal_blend` | 0.0 – 0.98 | History weight (higher = smoother) |
| GTSO | `use_gtso` | on/off | Bent normal specular occlusion |

The debug render mode `DEBUG_MODE_AO` (mode 7) visualizes the raw AO value as a grayscale passthrough, and `DEBUG_MODE_AO_SSAO` (mode 9) provides a comparison view. Both are selected via `debug_render_mode` in the GlobalUBO.

Sources: [debug_ui.cpp](https://github.com/1PercentSync/himalaya/blob/main/app/src/debug_ui.cpp#L579-L606), [forward.frag debug modes](https://github.com/1PercentSync/himalaya/blob/main/shaders/forward.frag#L288-L300), [bindings.glsl](https://github.com/1PercentSync/himalaya/blob/main/shaders/common/bindings.glsl#L81-L83)

## See Also

- [Forward Pass — Cook-Torrance PBR, IBL Split-Sum, and Multi-Bounce AO](https://github.com/1PercentSync/himalaya/blob/main/17-forward-pass-cook-torrance-pbr-ibl-split-sum-and-multi-bounce-ao) — consumption of `ao_filtered` for diffuse/specular occlusion
- [Depth Prepass — Z-Fill for Zero-Overdraw Forward Rendering](https://github.com/1PercentSync/himalaya/blob/main/16-depth-prepass-z-fill-for-zero-overdraw-forward-rendering) — produces the depth and normal buffers that GTAO reads
- [Render Graph — Automatic Barrier Insertion and Pass Orchestration](https://github.com/1PercentSync/himalaya/blob/main/9-render-graph-automatic-barrier-insertion-and-pass-orchestration) — managed image lifecycle and history tracking
- [GLSL Shader Architecture — Shared Bindings, BRDF Library, and Feature Flags](https://github.com/1PercentSync/himalaya/blob/main/25-glsl-shader-architecture-shared-bindings-brdf-library-and-feature-flags) — Set 0–2 layout and `FEATURE_AO` flag