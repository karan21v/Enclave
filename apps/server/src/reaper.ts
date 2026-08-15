import { prisma } from "./db.js";
import { memberCount } from "./rooms.js";

// Rooms are never deleted otherwise, and every keystroke is a row. On a small
// database that is a slow leak with no upper bound -- and since knowing a room
// id is enough to write to one, it is a leak a stranger can drive.
const RETENTION_DAYS = Number(process.env.ROOM_RETENTION_DAYS ?? 30);
const SWEEP_MS = 60 * 60 * 1000;

// Touching this on every append would be a write per keystroke, which is worse
// than the problem. Once per room per interval is enough -- the reaper only
// needs day resolution.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const lastTouched = new Map<string, number>();

export function touchRoom(roomId: string) {
  const now = Date.now();
  const previous = lastTouched.get(roomId) ?? 0;
  if (now - previous < TOUCH_INTERVAL_MS) return;

  lastTouched.set(roomId, now);

  // fire and forget. a missed touch costs nothing worse than an early sweep,
  // and the sweep skips rooms that still have someone in them anyway.
  prisma.room
    .update({ where: { id: roomId }, data: { lastActiveAt: new Date(now) } })
    .catch(() => lastTouched.delete(roomId));
}

export function forgetTouch(roomId: string) {
  lastTouched.delete(roomId);
}

export async function sweepIdleRooms(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const stale = await prisma.room.findMany({
    where: { lastActiveAt: { lt: cutoff } },
    select: { id: true },
  });

  // never delete a room somebody is sitting in. lastActiveAt is only touched
  // every 5 minutes, so a long silent session can look older than it is.
  const ids = stale.map((r) => r.id).filter((id) => memberCount(id) === 0);
  if (ids.length === 0) return 0;

  // events go with it -- Event.roomId is onDelete: Cascade
  const { count } = await prisma.room.deleteMany({ where: { id: { in: ids } } });
  for (const id of ids) lastTouched.delete(id);

  return count;
}

export function startReaper(log: { info: (msg: string) => void; error: (msg: string) => void }) {
  const run = () => {
    sweepIdleRooms()
      .then((n) => {
        if (n > 0) log.info(`reaped ${n} idle rooms`);
      })
      .catch((err) => log.error(`room sweep failed: ${err}`));
  };

  run(); // once at boot, so a restart doesn't reset the clock
  const timer = setInterval(run, SWEEP_MS);
  timer.unref(); // don't hold the process open
  return timer;
}
