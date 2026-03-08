# ShadCN Drop-in: Bottom Stick Scroll Area

This folder contains a single-file `BottomStickScrollArea` component meant for copy/paste into app source trees (ShadCN style).

## File

- `bottom-stick-scroll-area.tsx`

## Copy steps

1. Copy `bottom-stick-scroll-area.tsx` into your app, for example:
   - `components/ui/bottom-stick-scroll-area.tsx`
2. Keep/adjust these imports to match your app:
   - `@/components/ui/button`
   - `@/components/ui/scroll-area`
   - `@/lib/utils`
3. Ensure dependencies are installed:
   - `@radix-ui/react-scroll-area`
   - `lucide-react`

## Behavior

- Sticks instantly to bottom while content streams (`STICKY_INSTANT`).
- Detaches when user scrolls upward (`DETACHED`).
- "Scroll to bottom" button appears with a short fade and performs smooth return (`RETURNING_SMOOTH`).
- Supports canceling return if the user scrolls during animation.

For package-first usage (no copy/paste), use `BottomStickScrollArea` from `@stream-mdx/react`.
