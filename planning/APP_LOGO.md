---
status: COMPLETED
last_updated: 2025-12-16
reviewers: [review-ui, review-arch, review-testing, review-docs]
---

# APP_LOGO

## Overview

- **Problem**: CodeHydra lacks visual branding - no app icon and generic setup/empty screens
- **Solution**: Extract the hydra symbol from the provided logo, create app icons, and add animated logo to setup screens and empty workspace state
- **Risks**: Image processing quality (background removal accuracy); minimal risk otherwise
- **Alternatives Considered**:
  - SVG recreation (rejected - faster to process existing high-quality JPG; PNG maintains exact color fidelity with original artwork)

## Architecture

```
Source Image Processing Flow:
┌──────────────────────────────────────────────────────────────┐
│  ~/Downloads/codehydra.jpg                                   │
│  ┌─────────────────┬─────────────────────────────────────┐   │
│  │  Hydra Symbol   │     "CodeHydra" text                │   │
│  │  (extract this) │     (discard)                       │   │
│  └─────────────────┴─────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  ImageMagick Processing:                                     │
│  1. Crop left portion (symbol only) ~45% width               │
│  2. Remove dark blue background (#0d1a2d) → transparent      │
│  3. Generate multiple sizes (512, 256, 128, 48, 32, 16)      │
└──────────────────────────────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
┌─────────────────────────┐ ┌─────────────────────────────────┐
│  resources/             │ │  src/renderer/assets/           │
│  ├── icon.png (512x512) │ │  └── logo.png (128x128)         │
│  └── icon.ico (multi)   │ │      (imported by components)   │
│  (Build-time: packaged  │ │                                 │
│   app icons)            │ │                                 │
└─────────────────────────┘ └─────────────────────────────────┘
              │
              ▼
┌─────────────────────────┐
│  Runtime icon:          │
│  BaseWindow.setIcon()   │
│  in window-manager.ts   │
└─────────────────────────┘
```

## UI Design

### Setup Screen with Logo

```
┌──────────────────────────────────────────┐
│                                          │
│                                          │
│            ╭─────────────╮               │
│            │   🐉        │  ← Logo with  │
│            │  (hydra)    │    pulse glow │
│            ╰─────────────╯    animation  │
│              (128x128)                   │
│                 ↓ 2rem margin            │
│          Setting up VSCode...            │
│           Installing extensions          │
│          ══════════════════════          │
│                                          │
└──────────────────────────────────────────┘
```

### Setup Complete with Logo

```
┌──────────────────────────────────────────┐
│                                          │
│            ╭─────────────╮               │
│            │   🐉        │  ← Static     │
│            │  (hydra)    │    logo       │
│            ╰─────────────╯               │
│                  ✓                       │
│          Setup complete!                 │
│                                          │
└──────────────────────────────────────────┘
```

### Empty Workspace Backdrop with Logo

```
┌──────────────────────────────────────────────────────────────┐
│ Sidebar │                                                    │
│         │                                                    │
│ [Proj]  │              ╭─────────────╮                       │
│ ├─ ws1  │              │   🐉        │  ← Static, subtle     │
│ └─ ws2  │              │  (hydra)    │    opacity (0.15)     │
│         │              ╰─────────────╯    via CSS variable   │
│         │           min(256px, 30vw)                         │
│ [Open]  │        centered H+V in backdrop                    │
└─────────┴────────────────────────────────────────────────────┘
```

### User Interactions

- Logo is decorative only (no interactions)
- Animation runs only during active setup progress
- Static display in all other contexts

### Animation Specification

- **Type**: Opacity pulse (GPU-accelerated, performant)
- **Duration**: 2s per cycle
- **Timing**: ease-in-out
- **Opacity range**: 0.7 → 1.0 → 0.7
- **Iteration**: infinite (while animated=true)
- **Reduced motion**: No animation when `prefers-reduced-motion: reduce`

## Implementation Steps

- [x] **Step 1: Create directories and process source image**
  - Create `resources/` directory (for build-time app icons)
  - Create `src/renderer/assets/` directory (for runtime UI assets)
  - Use ImageMagick to process the logo:

    ```bash
    # Crop left ~45% of image (hydra symbol only)
    magick ~/Downloads/codehydra.jpg -crop 45%x100%+0+0 +repage hydra-cropped.png

    # Remove dark blue background, make transparent (fuzz 15% for gradient edges)
    magick hydra-cropped.png -fuzz 15% -transparent "#0d1a2d" hydra-transparent.png

    # Trim excess transparent space
    magick hydra-transparent.png -trim +repage hydra-trimmed.png

    # Generate sizes
    magick hydra-trimmed.png -resize 512x512 -gravity center -extent 512x512 resources/icon.png
    magick hydra-trimmed.png -resize 128x128 -gravity center -extent 128x128 src/renderer/assets/logo.png

    # Generate Windows ICO (multiple sizes embedded)
    magick hydra-trimmed.png \
      \( -clone 0 -resize 16x16 \) \
      \( -clone 0 -resize 32x32 \) \
      \( -clone 0 -resize 48x48 \) \
      \( -clone 0 -resize 256x256 \) \
      -delete 0 resources/icon.ico
    ```

  - Verify: transparent backgrounds with no dark edges or artifacts (check alpha channel is clean)
  - Files: `resources/icon.png`, `resources/icon.ico`, `src/renderer/assets/logo.png`
  - Test criteria: Files exist, are importable, have correct dimensions

- [x] **Step 2: Create Logo component with animation support**
  - Create `src/renderer/lib/components/Logo.svelte`
  - Use Svelte 5 runes pattern for props:
    ```typescript
    interface Props {
      size?: number;
      animated?: boolean;
    }
    const { size = 128, animated = false }: Props = $props();
    ```
  - Import logo.png as static asset
  - Render `<img src={logo} alt="" />` (empty alt for decorative image)
  - CSS animation using opacity (GPU-accelerated):
    ```css
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.7;
      }
      50% {
        opacity: 1;
      }
    }
    .animated {
      animation: pulse 2s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      .animated {
        animation: none;
        opacity: 1;
      }
    }
    ```
  - Files: `src/renderer/lib/components/Logo.svelte`, `src/renderer/lib/components/Logo.test.ts`
  - Test criteria: Renders image, applies animation class when animated=true, respects reduced motion

- [x] **Step 3: Add Logo to SetupScreen**
  - Import and add Logo component above heading
  - Pass `animated={true}` for pulse effect during setup
  - Add 2rem bottom margin below logo
  - Files: `src/renderer/lib/components/SetupScreen.svelte`, `src/renderer/lib/components/SetupScreen.test.ts`
  - Test criteria: Logo renders with animation during setup

- [x] **Step 4: Add Logo to SetupComplete**
  - Import and add Logo component above checkmark
  - Pass `animated={false}` for static display
  - Files: `src/renderer/lib/components/SetupComplete.svelte`, `src/renderer/lib/components/SetupComplete.test.ts`
  - Test criteria: Logo renders without animation

- [x] **Step 5: Add Logo to SetupError**
  - Import and add Logo component above error heading
  - Pass `animated={false}` for static display
  - Files: `src/renderer/lib/components/SetupError.svelte`, `src/renderer/lib/components/SetupError.test.ts`
  - Test criteria: Logo renders without animation

- [x] **Step 6: Add Logo to empty workspace backdrop**
  - Add CSS variable to `variables.css`: `--ch-logo-backdrop-opacity: 0.15;`
  - Update MainView.svelte's `.empty-backdrop` to include centered Logo
  - Use responsive size: `min(256px, 30vw)`
  - Center horizontally and vertically in backdrop area
  - Apply opacity via CSS variable
  - Pass `animated={false}`
  - Files: `src/renderer/lib/styles/variables.css`, `src/renderer/lib/components/MainView.svelte`, `src/renderer/lib/components/MainView.test.ts`
  - Test criteria: Logo appears when no workspace active, hidden when workspace active

- [x] **Step 7: Configure Electron to use app icon**
  - Update `src/main/managers/window-manager.ts`:
    - Import `nativeImage` from Electron
    - Use `BaseWindow.setIcon()` method to set runtime window icon
    - Load icon from `resources/icon.png` using path resolution relative to app root
  - Files: `src/main/managers/window-manager.ts`, `src/main/managers/window-manager.test.ts`
  - Test criteria: WindowManager correctly sets icon path, app shows custom icon in taskbar/dock

## Testing Strategy

### Unit Tests (vitest)

| Test Case                    | Description                                    | File                   |
| ---------------------------- | ---------------------------------------------- | ---------------------- |
| Logo asset loads             | Import logo.png succeeds with valid dimensions | Logo.test.ts           |
| Logo renders img             | Component renders img element                  | Logo.test.ts           |
| Logo has empty alt           | Img has alt="" for accessibility (decorative)  | Logo.test.ts           |
| Logo animation class         | Applies animation class when animated=true     | Logo.test.ts           |
| Logo no animation class      | No animation class when animated=false         | Logo.test.ts           |
| Logo respects size           | Applies width/height from size prop            | Logo.test.ts           |
| Logo default size            | Uses 128px when size prop undefined            | Logo.test.ts           |
| Logo reduced motion          | No animation when prefers-reduced-motion set   | Logo.test.ts           |
| SetupScreen has logo         | Renders Logo with animated=true                | SetupScreen.test.ts    |
| SetupComplete has logo       | Renders Logo with animated=false               | SetupComplete.test.ts  |
| SetupError has logo          | Renders Logo with animated=false               | SetupError.test.ts     |
| MainView shows backdrop logo | Renders Logo when no active workspace          | MainView.test.ts       |
| MainView hides backdrop logo | No Logo rendered when workspace active         | MainView.test.ts       |
| WindowManager sets icon      | Calls setIcon with correct path                | window-manager.test.ts |

### Integration Tests

No new integration tests needed - this is purely visual/UI.

### Manual Testing Checklist

- [ ] App icon appears in taskbar/dock (Linux/macOS/Windows)
- [ ] Logo pulses during setup progress
- [ ] Logo is static on setup complete screen
- [ ] Logo is static on setup error screen
- [ ] Logo appears as subtle watermark when no workspace selected
- [ ] Logo hidden when workspace is active
- [ ] Animation respects prefers-reduced-motion
- [ ] Logo has transparent background (no dark square)
- [ ] Logo scales properly on different window sizes (backdrop)

## Dependencies

No new dependencies required. ImageMagick is used for one-time image processing only (dev tool, not runtime).

## Documentation Updates

### Files to Update

| File                   | Changes Required                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs/USER_INTERFACE.md | Update setup screen mockups (lines ~155-201) to show logo above headings; update empty state mockup (lines ~225-234) to show centered logo watermark |

### New Documentation Required

None required.

## Definition of Done

- [ ] All implementation steps complete
- [ ] `npm run validate:fix` passes
- [ ] Documentation updated (USER_INTERFACE.md mockups)
- [ ] User acceptance testing passed
- [ ] Changes committed
