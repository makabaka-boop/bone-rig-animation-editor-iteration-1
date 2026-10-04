import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStore } from '../state/useEditor';
import { evaluatePose } from '../core/skeleton';
import type { Vec2, WorldPose } from '../core/types';
import { dist } from '../core/math2d';

const HANDLE_R = 7;
const JOINT_R = 4;

type HitTarget =
  | { kind: 'end'; boneId: string }
  | { kind: 'bone'; boneId: string }
  | null;

export function CanvasView() {
  const store = useStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<HitTarget>(null);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);

  // 最新输入位置（拖动期间指针事件可能比一帧多次，用 rAF 合并）
  const pendingPointer = useRef<Vec2 | null>(null);
  const dragging = useRef(false);

  // --- 播放循环：tick 驱动 store.time；画面渲染在下方的 effect 里跟随 state ---
  useEffect(() => {
    const loop = (ts: number) => {
      const last = lastTsRef.current || ts;
      const dt = Math.min(0.05, (ts - last) / 1000);
      lastTsRef.current = ts;
      const s = store.getState();
      if (s.playing) {
        store.tick(dt);
      }
      // 拖动中：在 rAF 里消化一次指针移动（模拟「计算结果」，并受修订闸门保护）
      if (dragging.current && pendingPointer.current) {
        const p = pendingPointer.current;
        pendingPointer.current = null;
        // 用闸门发起一次「计算」：本项目 IK 为同步解，
        // 这里通过微任务模拟异步调度，验证迟到结果被新修订丢弃
        const revAtSchedule = store.getState().history.rev;
        void Promise.resolve().then(() => {
          if (store.getState().history.rev !== revAtSchedule) return; // 修订已变，丢弃
          store.updateDrag(p);
        });
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [store]);

  // --- 渲染：跟随 store 状态（含 time / 修订） ---
  const state = useStoreStateFrame();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h, state.pose, state.selection, hover, state.draggingId);
  });

  const toWorld = (e: React.PointerEvent): Vec2 => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitTest = (world: Vec2, pose: WorldPose): HitTarget => {
    // 末端控制点优先（命中半径更大）
    for (const w of pose) {
      if (dist(world, w.end) <= HANDLE_R + 2) return { kind: 'end', boneId: w.id };
    }
    for (const w of pose) {
      if (pointToSegment(world, w.start, w.end) <= 6) return { kind: 'bone', boneId: w.id };
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const world = toWorld(e);
    const s = store.getState();
    const pose = evaluatePose(s.history.present, s.time, { rootPosition: s.rootPosition });
    const hit = hitTest(world, pose);
    if (!hit) {
      store.select(null);
      return;
    }
    store.select(hit.boneId);
    if (hit.kind === 'end') {
      // 任意骨骼末端都可拖：有父则两节骨链 IK，根则整体旋转
      store.beginDrag(hit.boneId);
      dragging.current = true;
      pendingPointer.current = world;
      canvasRef.current!.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const world = toWorld(e);
    const s = store.getState();
    if (dragging.current && s.drag) {
      pendingPointer.current = world;
      return;
    }
    const pose = evaluatePose(s.history.present, s.time, { rootPosition: s.rootPosition });
    setHover(hitTest(world, pose));
  };

  const finishDrag = (cancel: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    pendingPointer.current = null;
    if (cancel) store.cancelDrag();
    else store.endDrag();
  };

  const onPointerUp = () => finishDrag(false);
  const onPointerCancel = () => finishDrag(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finishDrag(true);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        store.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const s = store.getState();
  const cursorClass = dragging.current
    ? 'ik-grabbing'
    : hover?.kind === 'end'
      ? 'ik-grab'
      : '';

  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        className={cursorClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      {s.ikClamped && s.drag && (
        <div className="clamp-toast">目标超出可达距离，末端已贴到边界</div>
      )}
      <div className="canvas-hint">
        拖动末端控制点进行逆向定位（自动遵守关节限位） · ESC 取消拖动 · Ctrl+Z / Ctrl+Y 撤销重做
      </div>
    </div>
  );
}

/** 每个渲染帧都读最新 state（订阅触发重渲染，值在这里现取，避免闭包旧值） */
function useStoreStateFrame() {
  const store = useStore();
  useSyncExternalStore(store.subscribe, store.getState);
  const s = store.getState();
  const pose = evaluatePose(s.history.present, s.time, { rootPosition: s.rootPosition });
  return {
    pose,
    selection: s.selection,
    draggingId: s.drag?.childId ?? null,
  };
}

function pointToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  let t = (apx * abx + apy * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + abx * t;
  const qy = a.y + aby * t;
  return Math.hypot(p.x - qx, p.y - qy);
}

function draw(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  pose: WorldPose,
  selection: string | null,
  hover: HitTarget,
  draggingId: string | null
) {
  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);

  // 被拖动/悬停末端所属两节骨链的可达包络（外圆 l1+l2，内圆 |l1-l2|）
  const focusEndId = draggingId ?? (hover?.kind === 'end' ? hover.boneId : null);
  if (focusEndId) {
    const child = pose.find((b) => b.id === focusEndId);
    const parent = child?.parentId ? pose.find((b) => b.id === child.parentId) : undefined;
    if (child && parent) {
      const active = draggingId === focusEndId;
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = active ? 'rgba(62,207,142,0.55)' : 'rgba(79,157,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(parent.start.x, parent.start.y, parent.length + child.length, 0, Math.PI * 2);
      ctx.stroke();
      if (Math.abs(parent.length - child.length) > 0.5) {
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.arc(parent.start.x, parent.start.y, Math.abs(parent.length - child.length), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // 骨骼
  for (const bone of pose) {
    const selected = bone.id === selection;
    ctx.strokeStyle = selected ? '#4f9dff' : '#8ea2c0';
    ctx.lineWidth = selected ? 7 : 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bone.start.x, bone.start.y);
    ctx.lineTo(bone.end.x, bone.end.y);
    ctx.stroke();

    // 方向小箭头
    const mx = (bone.start.x + bone.end.x) / 2;
    const my = (bone.start.y + bone.end.y) / 2;
    ctx.fillStyle = selected ? '#bcd8ff' : '#465064';
    ctx.beginPath();
    ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 关节点
  for (const bone of pose) {
    ctx.fillStyle = bone.parentId === null ? '#f0b429' : '#e6e9ef';
    ctx.strokeStyle = '#1a1d23';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(bone.start.x, bone.start.y, bone.parentId === null ? 6 : JOINT_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // 末端控制点（每根骨骼都有，末端骨更大）
  for (let i = 0; i < pose.length; i++) {
    const bone = pose[i];
    const isLeaf = !pose.some((b) => b.parentId === bone.id);
    const r = isLeaf ? HANDLE_R + 1 : HANDLE_R - 2;
    const hovered = hover?.kind === 'end' && hover.boneId === bone.id;
    const active = draggingId === bone.id;
    ctx.fillStyle = active ? '#3ecf8e' : hovered ? '#7fc4ff' : '#4f9dff';
    ctx.strokeStyle = '#0c2743';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bone.end.x, bone.end.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#20242c';
  const step = 40;
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
}
