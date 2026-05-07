import re
import csv
import shutil
import hashlib
import difflib
import argparse
import datetime
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from PIL import Image
from tqdm import tqdm

# ---------------------------
# CONFIG
# ---------------------------

SIMILARITY_THRESHOLD = 0.92
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_WORKERS = None  # None = auto

# ---------------------------
# NORMALIZATION
# ---------------------------

def normalize_name(name: str) -> str:
    name = re.sub(r"\(.*?\)", "", name)
    name = re.sub(r"\[.*?\]", "", name)
    name = re.sub(r"[-–—]+", " ", name)
    name = re.sub(r"[^\w\s]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name.strip().lower()

# ---------------------------
# FUZZY GROUPING
# ---------------------------

def group_folders(base_path: Path):
    folders = [f for f in base_path.iterdir() if f.is_dir()]
    normalized = [(f, normalize_name(f.name)) for f in folders]

    groups = []
    used = set()

    for i, (fa, na) in enumerate(normalized):
        if i in used:
            continue

        group = [fa]
        used.add(i)

        for j, (fb, nb) in enumerate(normalized):
            if j in used:
                continue

            sim = difflib.SequenceMatcher(None, na, nb).ratio()
            if sim >= SIMILARITY_THRESHOLD:
                group.append(fb)
                used.add(j)

        groups.append(group)

    return groups

# ---------------------------
# HASHING (PARALLEL)
# ---------------------------

def hash_worker(path_str):
    try:
        h = hashlib.sha256()
        with open(path_str, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return (path_str, h.hexdigest(), None)
    except Exception as e:
        return (path_str, None, str(e))

def parallel_hash(paths, desc="Hashing"):
    results = {}

    with ProcessPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = [ex.submit(hash_worker, str(p)) for p in paths]

        for f in tqdm(as_completed(futures), total=len(futures), desc=desc):
            path_str, h, err = f.result()
            p = Path(path_str)

            if err:
                print(f"Hash error: {p} -> {err}")
                continue

            results[p] = h

    return results

# ---------------------------
# IMAGE UTILS
# ---------------------------

def is_image(p: Path):
    return p.suffix.lower() in IMAGE_EXTENSIONS

def resolution(p: Path):
    try:
        with Image.open(p) as img:
            return img.width * img.height
    except:
        return 0

# ---------------------------
# LOGGING
# ---------------------------

def log(msg, f):
    print(msg)
    f.write(msg + "\n")

# ---------------------------
# PROPOSE
# ---------------------------

def propose(base_path, csv_path):
    base = Path(base_path)
    groups = group_folders(base)

    proposals = []

    for g in groups:
        if len(g) < 2:
            continue

        g_sorted = sorted(g, key=lambda x: len(x.name))
        target = g_sorted[0]

        for src in g_sorted[1:]:
            proposals.append({
                "action": "merge",
                "source_folder": str(src),
                "target_folder": str(target),
                "source_name": src.name,
                "target_name": target.name
            })

    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=proposals[0].keys() if proposals else [
            "action","source_folder","target_folder","source_name","target_name"
        ])
        writer.writeheader()
        writer.writerows(proposals)

    print(f"Proposals written: {csv_path}")
    print(f"Total: {len(proposals)}")

# ---------------------------
# EXECUTE
# ---------------------------

def execute(csv_path, log_path):
    stats = defaultdict(int)

    with open(log_path, "w", encoding="utf-8") as logfile:
        log(f"=== START {datetime.datetime.now()} ===", logfile)

        with open(csv_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)

            for row in reader:
                if row["action"] != "merge":
                    continue

                src = Path(row["source_folder"])
                dst = Path(row["target_folder"])

                if not src.exists() or not dst.exists():
                    log(f"SKIP missing: {src} / {dst}", logfile)
                    stats["skipped"] += 1
                    continue

                log(f"\nMERGE: {src} -> {dst}", logfile)
                stats["merges"] += 1

                target_files = [f for f in dst.iterdir() if f.is_file()]
                target_hashes = parallel_hash(target_files, desc="Hashing target")
                hash_map = {h: p for p, h in target_hashes.items()}

                source_files = [f for f in src.iterdir() if f.is_file()]
                source_hashes = parallel_hash(source_files, desc="Hashing source")

                for item in tqdm(source_files, desc="Processing files"):
                    h = source_hashes.get(item)
                    if not h:
                        stats["errors"] += 1
                        continue

                    # Duplicate
                    if h in hash_map:
                        log(f"DELETE duplicate: {item}", logfile)
                        item.unlink()
                        stats["duplicates"] += 1
                        continue

                    dest = dst / item.name

                    # Conflict
                    if dest.exists():
                        if is_image(item) and is_image(dest):
                            src_res = resolution(item)
                            dst_res = resolution(dest)

                            if src_res > dst_res:
                                log(f"REPLACE lower-res: {dest}", logfile)
                                dest.unlink()
                                shutil.move(item, dest)
                                stats["replaced"] += 1
                            else:
                                log(f"DROP lower-res: {item}", logfile)
                                item.unlink()
                                stats["dropped"] += 1
                        else:
                            new_dest = dst / f"{item.stem}_merge{item.suffix}"
                            log(f"RENAME: {item} -> {new_dest}", logfile)
                            shutil.move(item, new_dest)
                            stats["renamed"] += 1
                    else:
                        shutil.move(item, dest)
                        stats["moved"] += 1

                try:
                    src.rmdir()
                    log(f"REMOVED: {src}", logfile)
                    stats["folders_removed"] += 1
                except:
                    log(f"NOT EMPTY: {src}", logfile)

        log("\n=== SUMMARY ===", logfile)
        for k, v in stats.items():
            log(f"{k}: {v}", logfile)

        log(f"=== END {datetime.datetime.now()} ===", logfile)

# ---------------------------
# CLI
# ---------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser()

    parser.add_argument("mode", choices=["propose", "execute"])
    parser.add_argument("--path")
    parser.add_argument("--csv", required=True)
    parser.add_argument("--log", default="merge_log.txt")

    args = parser.parse_args()

    if args.mode == "propose":
        if not args.path:
            raise ValueError("Need --path")
        propose(args.path, args.csv)

    elif args.mode == "execute":
        execute(args.csv, args.log)