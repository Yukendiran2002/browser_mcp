import { Page } from "playwright";

/**
 * Human-like browser interaction helpers.
 *
 * Makes browser automation indistinguishable from a real user by adding:
 * - Natural mouse movements (Bezier curves with jitter)
 * - Realistic typing speed (variable delays, occasional pauses)
 * - Random action delays (humans don't click instantly)
 * - Smooth scrolling with variable speed
 * - Click coordinate jitter (humans don't click exact center)
 */

// ─── Random Helpers ─────────────────────────────────────────

/** Random number between min and max (inclusive). */
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random float between min and max. */
function randf(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Sleep for a random duration within range. */
export function humanDelay(minMs = 50, maxMs = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, rand(minMs, maxMs)));
}

/** Small micro-delay to simulate reaction time. */
export function microDelay(): Promise<void> {
  return humanDelay(30, 120);
}

/** Thinking pause — longer delay between major actions. */
export function thinkingPause(): Promise<void> {
  return humanDelay(200, 600);
}

// ─── Mouse Movement (Bezier Curves) ─────────────────────────

interface Point {
  x: number;
  y: number;
}

/** Generate a cubic Bezier curve point at parameter t. */
function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Generate natural mouse path from start to end using Bezier curves. */
function generateMousePath(start: Point, end: Point, steps: number): Point[] {
  // Random control points that simulate human hand movement arcs
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  const cp1: Point = {
    x: start.x + dx * randf(0.2, 0.4) + randf(-30, 30),
    y: start.y + dy * randf(0.1, 0.3) + randf(-30, 30),
  };
  const cp2: Point = {
    x: start.x + dx * randf(0.6, 0.8) + randf(-20, 20),
    y: start.y + dy * randf(0.7, 0.9) + randf(-20, 20),
  };

  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Speed easing: slow start, fast middle, slow end (like real hand)
    const eased = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const p = bezierPoint(start, cp1, cp2, end, eased);
    // Add tiny jitter to each point
    points.push({
      x: Math.round(p.x + randf(-1, 1)),
      y: Math.round(p.y + randf(-1, 1)),
    });
  }
  return points;
}

/**
 * Move the mouse along a natural-looking Bezier curve path.
 */
export async function humanMouseMove(page: Page, toX: number, toY: number): Promise<void> {
  // Get current mouse position (or start from a random viewport edge)
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const currentPos = (page as any).__lastMousePos || {
    x: rand(0, viewport.width),
    y: rand(0, viewport.height),
  };

  const distance = Math.sqrt(Math.pow(toX - currentPos.x, 2) + Math.pow(toY - currentPos.y, 2));
  // More steps for longer distances, fewer for short ones
  const steps = Math.max(5, Math.min(25, Math.floor(distance / 30)));

  const path = generateMousePath(currentPos, { x: toX, y: toY }, steps);

  for (const point of path) {
    await page.mouse.move(point.x, point.y);
    // Variable speed: faster in the middle, slower at endpoints
    await new Promise((r) => setTimeout(r, rand(2, 12)));
  }

  // Store position for next movement
  (page as any).__lastMousePos = { x: toX, y: toY };
}

/**
 * Human-like click: move mouse naturally to target, then click.
 * Adds slight coordinate jitter (humans don't click exact center).
 */
export async function humanClick(
  page: Page,
  x: number,
  y: number,
  options: { button?: "left" | "right" | "middle"; clickCount?: number } = {}
): Promise<void> {
  // Add slight jitter to coordinates (±3px)
  const jitterX = x + rand(-3, 3);
  const jitterY = y + rand(-3, 3);

  // Move mouse naturally to the target
  await humanMouseMove(page, jitterX, jitterY);

  // Small pause before clicking (human reaction time)
  await microDelay();

  // Click
  await page.mouse.click(jitterX, jitterY, {
    button: options.button ?? "left",
    clickCount: options.clickCount ?? 1,
    delay: rand(40, 120), // Time between mouse down and up
  });

  // Small pause after click
  await microDelay();
}

/**
 * Human-like typing: variable delays between keystrokes.
 * Simulates different speeds for different characters.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Type the character
    await page.keyboard.type(char, { delay: 0 });

    // Variable delay based on character type
    let delay: number;
    if (char === " ") {
      delay = rand(30, 80); // Spaces are fast
    } else if (char === "\n" || char === ".") {
      delay = rand(100, 250); // Pauses at end of sentences/lines
    } else if (/[A-Z]/.test(char)) {
      delay = rand(60, 130); // Uppercase takes longer (shift key)
    } else if (/[0-9]/.test(char)) {
      delay = rand(70, 140); // Numbers are slightly slower
    } else if (/[!@#$%^&*()]/.test(char)) {
      delay = rand(80, 160); // Special chars are slowest
    } else {
      delay = rand(30, 100); // Normal characters
    }

    // Occasional longer pause (thinking/reading what was typed)
    if (Math.random() < 0.05) {
      delay += rand(200, 500);
    }

    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Human-like scrolling: smooth scroll with variable speed.
 */
export async function humanScroll(
  page: Page,
  deltaY: number,
  deltaX = 0
): Promise<void> {
  const totalSteps = Math.max(3, Math.min(12, Math.abs(deltaY) / 80));
  const stepY = deltaY / totalSteps;
  const stepX = deltaX / totalSteps;

  for (let i = 0; i < totalSteps; i++) {
    // Add slight randomness to each scroll step
    const scrollY = stepY + randf(-10, 10);
    const scrollX = stepX + randf(-5, 5);
    await page.mouse.wheel(scrollX, scrollY);
    // Variable delay between scroll steps
    await new Promise((r) => setTimeout(r, rand(20, 80)));
  }

  // Small pause after scrolling (reading)
  await humanDelay(100, 300);
}

/**
 * Human-like hover: move naturally and pause.
 */
export async function humanHover(page: Page, x: number, y: number): Promise<void> {
  await humanMouseMove(page, x + rand(-2, 2), y + rand(-2, 2));
  await humanDelay(150, 400); // Humans pause after hovering
}

/**
 * Simulate human pre-action behavior:
 * Small random delay before any action (thinking/reading time).
 */
export async function beforeAction(): Promise<void> {
  await humanDelay(80, 250);
}
