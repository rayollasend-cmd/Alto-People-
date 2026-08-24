-- Floor Supervisor: watch-only step-down from SHIFT_SUPERVISOR.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'FLOOR_SUPERVISOR';
