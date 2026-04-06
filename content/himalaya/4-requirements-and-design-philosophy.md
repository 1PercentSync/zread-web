This document explains the foundational principles that guide every technical decision in Himalaya. Understanding these principles helps you navigate the codebase with context—why certain approaches were chosen over alternatives, and how the project balances competing concerns like quality, performance, and complexity.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L1-L175)

---

## Project Positioning

Himalaya is a **Vulkan-based real-time renderer** designed as a personal learning and practice project. It begins with rasterization as its foundation while maintaining architectural considerations for future hybrid ray tracing and pure path tracing pipelines.

The project operates under a unique constraint: **AI-assisted development**. This means the bottleneck is not writing code—AI can generate entire rendering systems—but rather reviewing, understanding, and making correct architectural decisions. This constraint directly influences many design choices, favoring well-documented, proven techniques over experimental approaches.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L1-L20), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L1-L50)

---

## Hardware Targets and Performance Philosophy

### Primary Target Platforms

| Platform | Description |
|----------|-------------|
| Mid-range Desktop Gaming | The sweet spot for performance-to-quality ratio |
| High-end PCVR | Not standalone VR headsets |

The renderer aims for the **sweet spot** of current hardware and rendering technology—where performance investment yields the best visual returns. It neither over-optimizes for low-end devices nor pursues techniques requiring bleeding-edge hardware.

### Mobile Compatibility Principle

A guiding principle is **"don't close the door on mobile"**. For architecture-level decisions that cannot be modularly replaced later:

- Desktop mid-range should run well
- Mobile mid-to-high-end should be capable of running

This does not mean mobile-specific optimization, but rather avoiding architectural choices that would put mobile at a fundamental disadvantage. Specific implementations can remain desktop-focused.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L21-L45)

---

## Core Design Principles

The following nine principles govern all technical decisions in Himalaya. Understanding them explains why certain technologies were selected or excluded.

### Principle 1: Exclude Overly Complex Technologies with Low Returns

**Complexity must be proportional to benefit.** If a technology's implementation cost far exceeds its visual or performance gains, it is excluded.

**Applied Examples:**
- **Excluded**: GPU-Driven Rendering (complexity spreads across entire architecture; unnecessary for moderate scene scales)
- **Excluded**: Virtual Shadow Maps (extremely complex implementation; CSM satisfies requirements)

Sources: [decision-process.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/decision-process.md#L300-L320), [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L46-L55)

### Principle 2: Progressive Implementation

**Make it work, then make it good, then make it excellent.** Each module follows a Pass 1/2/3 staged approach:

| Pass | Goal | Example |
|------|------|---------|
| **Pass 1** | Minimum viable version | Brute-force Forward rendering, basic Shadow Map |
| **Pass 2** | Low-complexity, high-return upgrades | Tiled Forward, CSM |
| **Pass 3** | Tolerable complexity for further gains | Clustered Forward |

Not every module requires all three passes—some start at Pass 2, others skip intermediate steps. Evolution between passes should be natural (building upon rather than replacing).

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L56-L70)

### Principle 3: Industry-Validated Technologies

Adopt techniques already proven in industry with mature implementations and abundant documentation. **Avoid experimental approaches.** Documentation richness directly impacts AI-assisted development reliability.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L71-L75)

### Principle 4: Performance-Quality Ratio

Technical selection always considers the ratio of performance cost to visual quality. Choose the more performant option for equal quality; choose the better-looking option for equal performance.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L76-L80)

### Principle 5: Hybrid Pipeline Compatibility is a Bonus

When choosing between options A and B, if A can persist into a hybrid pipeline while B cannot, A may have slightly longer implementation time or slightly worse performance. However, **never sacrifice strongly perceptible current quality for compatibility**.

**Applied Example**: Forward+ lacks GBuffer naturally, but thin GBuffer can be generated on-demand (cost only exists when RT is enabled). The RT baking stage merges with the first RT pipeline application.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L81-L90)

### Principle 6: No Obvious Glitches

Images may be imprecise but must not have obvious visual artifacts. Between sharp+flickering and blurred+stable, choose the latter. Between over-drawing and under-drawing, choose over-drawing.

**Applied Examples:**
- CSM texel snapping (eliminates movement flicker)
- PCSS with temporal filtering (eliminates sampling noise)
- Hardware Occlusion Query conservative two-pass strategy (zero under-drawing)

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L91-L100)

### Principle 7: Design Constraints for Technical Simplicity

Accept reduced scene dynamic flexibility in exchange for visual quality and performance priority.

**Applied Examples:**
- Limit simultaneously visible interactive doors to one (avoids lightmap combinatorial explosion)
- Multiple lightmap sets with blending instead of real-time GI (solves problems typically requiring complex real-time GI systems)

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L101-L110)

### Principle 8: AI-Assisted Development Efficiency

AI can write entire renderers directly; the bottleneck is review, understanding, and rework from lack of experience. Therefore:
- Solution documentation richness and maturity matter greatly
- Architectural decision correctness outweighs implementation speed
- Modular design limits rework impact scope

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L111-L120)

### Principle 9: Plugin Architecture and Deferred Implementation

Not everything needs immediate implementation. Post-processing effects are naturally independent full-screen passes, suitable for plugin-style design with independent enable/disable, scheduled after the rendering system core is complete.

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L121-L125)

---

## Visual Quality Goals

### Primary Direction

Pursue **photorealism** within all above constraints. The focus is standard PBR opaque scene realistic rendering.

### Material Requirements

| Category | Priority | Description |
|----------|----------|-------------|
| **Primary** | High | Standard PBR Metallic-Roughness workflow |
| **Retained Capability** | Medium | Toon rendering (similar to Chinese anime game style) for scenes and characters |
| **Low Priority** | Low | Water, transparency, volumetric rendering—needed but not highest priority |

### Visual Preferences

- Do not pursue absolute precision, but do not accept obvious visual errors
- Prefer blur over flickering
- Prefer over-drawing (rendering a few actually occluded objects) over under-drawing (objects suddenly disappearing/appearing)
- Accept design constraints (like limiting interactive element count) for cleaner technical solutions

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L126-L145)

---

## Scene and Content Assumptions

The following assumptions directly influence technical selection:

| Assumption | Impact on Decision |
|------------|-------------------|
| Few dynamic lights, baking techniques will be used | Deferred multi-light advantage weakened → Forward+ |
| Few dynamic objects (static environment primary) | Lightmap blend can cover most GI needs |
| Standard PBR as primary shading | Deferred GBuffer encoding pressure small (but still chose Forward+) |
| Not doing ultra-large open world | No need for GPU-Driven, HLOD, World Streaming |
| Day-night cycle requirement | Multiple lightmap sets blend, dynamic sky (Bruneton) |
| Both indoor and outdoor | GI solution must balance both (Lightmap for indoor, height fog/atmosphere for outdoor) |
| VR support (PCVR) | MSAA importance increased, bandwidth sensitivity reduced (not standalone headset) |

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L146-L160)

---

## Key Design Philosophy: Offline Quality for Real-Time Problems

The **multiple lightmap set blending** technique best embodies the project's design philosophy—using pure offline-baked high-quality indirect lighting data, combined with near-zero-cost runtime interpolation, solves problems typically requiring complex real-time GI systems (day-night changes, scene state transitions).

This approach trades storage space (N sets of lightmaps) for:
- Runtime performance (almost zero overhead—just sampling two textures and lerping)
- Visual quality (offline path tracing quality)
- Implementation simplicity (no complex probe management or leakage handling)

Sources: [decision-process.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/decision-process.md#L100-L130), [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L161-L175)

---

## Infrastructure Reuse Pattern

Multiple seemingly independent systems share underlying infrastructure—invest once, benefit everywhere:

| Infrastructure | Shared By |
|----------------|-----------|
| **Temporal filtering** | SSAO/GTAO, SSGI, SSR (per-effect denoising) |
| **Motion Vectors** | All temporal effects + DLSS/FSR + Motion Blur |
| **Screen-space Ray March** | SSR and SSGI share core code |
| **BRDF Integration LUT** | IBL Split-Sum and Multiscatter GGX share generation infrastructure |
| **Depth PrePass** | Forward+ standard, all screen-space effects input, Hardware OQ reuse |

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L176-L190)

---

## Replacement vs. Accumulation

Some technologies have clear replacement relationships—later phase implementation retires earlier phase:

| Early Phase | Replaced By |
|-------------|-------------|
| Height Fog | Bruneton aerial perspective |
| Screen-Space God Rays | Froxel Volumetric Fog |
| Hosek-Wilkie | Bruneton (therefore skipped directly) |
| 2D Clouds | Volumetric Clouds (future) |
| Offline tool baking | RT baking |

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L191-L200)

---

## Conditional Evolution Paths

Some technology evolution depends on other systems' existence:

| Technology | Condition |
|------------|-----------|
| SDF shadow blending | Only when GI introduces SDF infrastructure |
| Irradiance Probes | Only when SDF infrastructure exists |
| WBOIT | Only when simple sorting has actual problems |
| Shadow Atlas | Only when light count grows requiring scheduling |

Sources: [requirements-and-philosophy.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/requirements-and-philosophy.md#L201-L210)

---

## Architecture Overview

The renderer follows a strict four-layer architecture with compile-time enforced unidirectional dependencies:

```
┌─────────────────────────────────────┐
│  Layer 3: Application Layer         │  Scene loading, camera control, UI
│  (himalaya::app)                    │
├─────────────────────────────────────┤
│  Layer 2: Render Pass Layer         │  Individual render passes (shadow, AO, etc.)
│  (himalaya::passes)                 │
├─────────────────────────────────────┤
│  Layer 1: Render Framework Layer    │  Render Graph, material system, mesh management
│  (himalaya::framework)              │
├─────────────────────────────────────┤
│  Layer 0: Vulkan Abstraction Layer  │  RHI - resources, pipelines, commands
│  (himalaya::rhi)                    │
└─────────────────────────────────────┘
           ↓ Strict downward dependency only
```

**Key constraint**: `rhi/` does not reference `framework/`, `framework/` does not reference `passes/`, and passes do not reference each other.

Sources: [architecture.md](https://github.com/1PercentSync/himalaya/blob/main/docs/project/architecture.md#L1-L50), [CLAUDE.md](https://github.com/1PercentSync/himalaya/blob/main/CLAUDE.md#L100-L130)

---

## Reading Path

Now that you understand the requirements and philosophy guiding Himalaya's development, the logical next steps are:

1. **[Architecture Overview](https://github.com/1PercentSync/himalaya/blob/main/5-architecture-overview)** — Deep dive into the four-layer architecture and component interactions
2. **[Technical Decisions and Technology Stack](https://github.com/1PercentSync/himalaya/blob/main/6-technical-decisions-and-technology-stack)** — Specific technology choices and their progressive evolution paths
3. **[Milestone 1 — Static Scene Rendering](https://github.com/1PercentSync/himalaya/blob/main/31-milestone-1-static-scene-rendering)** — Current implementation status and capabilities