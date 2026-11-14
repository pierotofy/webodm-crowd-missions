import os
import sqlite3
import threading
from app.plugins.functions import get_plugins_persistent_path

ROOT = get_plugins_persistent_path(os.path.basename(os.path.dirname(os.path.abspath(__file__))))

SCHEMA = """
CREATE TABLE IF NOT EXISTS missions(
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    aoi TEXT NOT NULL,
    cell_size REAL NOT NULL,
    params TEXT NOT NULL,
    tasks TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS cells(
    id INTEGER PRIMARY KEY,
    mission_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    geom TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    pilot_id INTEGER,
    pilot_name TEXT,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS cells_mission ON cells(mission_id);
CREATE TABLE IF NOT EXISTS images(
    id INTEGER PRIMARY KEY,
    mission_id INTEGER NOT NULL,
    cell_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    lat REAL,
    lon REAL,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(mission_id, filename)
);
CREATE INDEX IF NOT EXISTS images_cell ON images(cell_id);
"""

_lock = threading.Lock()
_ready = False


def connect():
    global _ready
    if not _ready:
        with _lock:
            if not _ready:
                os.makedirs(ROOT, exist_ok=True)
                c = sqlite3.connect(os.path.join(ROOT, "missions.sqlite"), timeout=30)
                c.execute("PRAGMA journal_mode=WAL")
                c.executescript(SCHEMA)
                if "open" not in [r[1] for r in c.execute("PRAGMA table_info(missions)")]:
                    c.execute("ALTER TABLE missions ADD COLUMN open INTEGER NOT NULL DEFAULT 0")
                    c.commit()
                c.close()
                _ready = True
    c = sqlite3.connect(os.path.join(ROOT, "missions.sqlite"), timeout=30, isolation_level=None)
    c.row_factory = sqlite3.Row
    return c


def mission_dir(mission_id):
    return os.path.join(ROOT, "missions", str(int(mission_id)))
