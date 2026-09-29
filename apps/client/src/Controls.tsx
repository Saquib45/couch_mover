import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { SHOUTS, type ShoutPhrase, type Vec2 } from "@couch-movers/shared";

interface JoystickProps {
  disabled?: boolean;
  onMove: (movement: Vec2) => void;
}

const STICK_RADIUS = 48;

export function Joystick({ disabled = false, onMove }: JoystickProps) {
  const [center, setCenter] = useState<Vec2 | null>(null);
  const [knob, setKnob] = useState<Vec2>({ x: 0, y: 0 });
  const pointerIdRef = useRef<number | null>(null);
  const centerRef = useRef<Vec2>({ x: 0, y: 0 });

  const updatePointer = useCallback(
    (clientX: number, clientY: number) => {
      const dx = clientX - centerRef.current.x;
      const dy = clientY - centerRef.current.y;
      const distance = Math.hypot(dx, dy);
      const scale = distance > STICK_RADIUS ? STICK_RADIUS / distance : 1;
      const next = { x: dx * scale, y: dy * scale };
      setKnob(next);
      onMove({ x: next.x / STICK_RADIUS, y: next.y / STICK_RADIUS });
    },
    [onMove],
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || pointerIdRef.current !== null) return;
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = Math.max(66, Math.min(rect.width - 66, event.clientX - rect.left));
    const localY = Math.max(66, Math.min(rect.height - 66, event.clientY - rect.top));
    const nextCenter = { x: rect.left + localX, y: rect.top + localY };
    centerRef.current = nextCenter;
    setCenter({ x: localX, y: localY });
    setKnob({ x: 0, y: 0 });
    onMove({ x: 0, y: 0 });
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    updatePointer(event.clientX, event.clientY);
  };

  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setCenter(null);
    setKnob({ x: 0, y: 0 });
    onMove({ x: 0, y: 0 });
  };

  useEffect(() => {
    if (!disabled) return;
    pointerIdRef.current = null;
    setCenter(null);
    setKnob({ x: 0, y: 0 });
    onMove({ x: 0, y: 0 });
  }, [disabled, onMove]);

  const baseStyle = center ? ({ left: center.x, top: center.y } satisfies CSSProperties) : undefined;

  return (
    <div
      className={`joystick-zone${disabled ? " is-disabled" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      aria-hidden="true"
    >
      <div className={`joystick-base${center ? " is-active" : ""}`} style={baseStyle}>
        <span className="joystick-arrows">+</span>
        <div className="joystick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
      </div>
      <span className="joystick-caption">MOVE</span>
    </div>
  );
}

interface ShoutWheelProps {
  disabled?: boolean;
  onShout: (phrase: ShoutPhrase) => void;
}

const SHOUT_POSITIONS: Array<{ phrase: ShoutPhrase; x: number; y: number }> = [
  { phrase: "LEFT!", x: -132, y: -24 },
  { phrase: "PIVOT!", x: -96, y: -112 },
  { phrase: "STOP!", x: 2, y: -142 },
  { phrase: "MY BAD", x: 101, y: -105 },
];

function closestShout(dx: number, dy: number): ShoutPhrase | null {
  const distance = Math.hypot(dx, dy);
  if (distance < 34) return null;
  let best: { phrase: ShoutPhrase; score: number } | null = null;
  for (const item of SHOUT_POSITIONS) {
    const itemLength = Math.hypot(item.x, item.y);
    const score = (dx * item.x + dy * item.y) / (distance * itemLength);
    if (!best || score > best.score) best = { phrase: item.phrase, score };
  }
  return best && best.score > 0.52 ? best.phrase : null;
}

export function ShoutWheel({ disabled = false, onShout }: ShoutWheelProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ShoutPhrase | null>(null);
  const originRef = useRef<Vec2>({ x: 0, y: 0 });
  const activePointerRef = useRef<number | null>(null);

  const choose = useCallback(
    (phrase: ShoutPhrase) => {
      onShout(phrase);
      setOpen(false);
      setSelected(null);
      if (navigator.vibrate) navigator.vibrate(22);
    },
    [onShout],
  );

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    originRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    activePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setOpen(true);
    setSelected(null);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    setSelected(closestShout(event.clientX - originRef.current.x, event.clientY - originRef.current.y));
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (selected) choose(selected);
    // A quick tap intentionally leaves the wheel open so it is keyboard and
    // switch-control friendly as well as hold-and-flick friendly.
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {open && <button className="shout-dismiss" aria-label="Close shout menu" onPointerDown={() => setOpen(false)} />}
      <div className={`shout-control${open ? " is-open" : ""}`}>
        {open && (
          <div className="shout-wheel" role="menu" aria-label="Quick shouts">
            <span className="shout-wheel-ring" />
            {SHOUT_POSITIONS.map((item) => {
              const style = {
                "--shout-x": `${item.x}px`,
                "--shout-y": `${item.y}px`,
              } as CSSProperties;
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={item.phrase}
                  className={`shout-option${selected === item.phrase ? " is-selected" : ""}`}
                  style={style}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => choose(item.phrase)}
                >
                  {item.phrase}
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className="control-button shout-button"
          aria-label="Open quick shout wheel. Hold and flick to choose."
          aria-expanded={open}
          disabled={disabled}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <span className="control-icon" aria-hidden="true">!</span>
          <span>SHOUT</span>
        </button>
      </div>
    </>
  );
}

interface GameControlsProps {
  gripped: boolean;
  gripTarget: "handle" | "rope";
  disabled?: boolean;
  onMove: (movement: Vec2) => void;
  onToggleGrip: () => void;
  onShout: (phrase: ShoutPhrase) => void;
}

export function GameControls({ gripped, gripTarget, disabled = false, onMove, onToggleGrip, onShout }: GameControlsProps) {
  const targetLabel = gripTarget === "rope" ? "ROPE" : "HANDLE";
  const gripAction = `${gripped ? "RELEASE" : "GRAB"} ${targetLabel}`;
  const toggleGrip = () => {
    onToggleGrip();
    if (navigator.vibrate) navigator.vibrate(gripped ? 18 : [18, 25, 18]);
  };

  return (
    <div className="game-controls" aria-label="Game controls">
      <Joystick disabled={disabled} onMove={onMove} />
      <div className="action-controls">
        <button
          type="button"
          className={`control-button grip-button${gripped ? " is-gripped" : ""}`}
          aria-pressed={gripped}
          aria-label={`${gripAction}. Space performs the same action on desktop.`}
          disabled={disabled}
          onClick={toggleGrip}
        >
          <span className="control-icon grip-icon" aria-hidden="true">{gripped ? "✓" : "✦"}</span>
          <span className="grip-action-label">{gripAction}</span>
        </button>
        <ShoutWheel disabled={disabled} onShout={onShout} />
      </div>
      <div className="desktop-control-hint" aria-hidden="true">
        <span><kbd>WASD</kbd> MOVE</span>
        <span><kbd>SPACE</kbd> {gripAction}</span>
        <span><kbd>1–4</kbd> SHOUT</span>
      </div>
    </div>
  );
}

export const NUMBER_SHOUTS: Readonly<Record<string, ShoutPhrase>> = {
  "1": SHOUTS[0],
  "2": SHOUTS[1],
  "3": SHOUTS[2],
  "4": SHOUTS[3],
};
