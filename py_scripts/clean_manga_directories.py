import os
import re
import csv
import shutil
import hashlib
from pathlib import Path

# ---------------------------
# Helpers
# ---------------------------

def normalize_name(name: str) -> str:
    name = re.sub(r"\(.*?\)", "", name)
    name = re.sub(r"\[.*?\]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name.strip().lower()


def hash_file(path: Path, chunk_size=8192):
    """
    Compute SHA-256 hash of a file.
    """
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(chunk_size):
            hasher.update(chunk)
    return hasher.hexdigest()


def build_hash_map(folder: Path):
    """
    Build hash map of files in target folder.
    Returns: {hash: Path}
    """
    hash_map = {}

    for item in folder.iterdir():
        if item.is_file():
            try:
                file_hash = hash_file(item)
                hash_map[file_hash] = item
            except Exception as e:
                print(f"Error hashing {item}: {e}")

    return hash_map


def get_folder_groups(base_path: Path):
    groups = {}

    for item in base_path.iterdir():
        if item.is_dir():
            norm = normalize_name(item.name)
            groups.setdefault(norm, []).append(item)

    return groups


# ---------------------------
# Phase 1: Propose
# ---------------------------

def propose_merges(base_path: str, output_csv: str):
    base = Path(base_path)
    groups = get_folder_groups(base)

    proposals = []

    for norm_name, folders in groups.items():
        if len(folders) < 2:
            continue

        folders_sorted = sorted(folders, key=lambda x: len(x.name))
        target = folders_sorted[0]

        for source in folders_sorted[1:]:
            proposals.append({
                "action": "merge",
                "source_folder": str(source),
                "target_folder": str(target),
                "normalized_name": norm_name,
                "source_name": source.name,
                "target_name": target.name
            })

    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "action", "source_folder", "target_folder",
            "normalized_name", "source_name", "target_name"
        ])
        writer.writeheader()
        writer.writerows(proposals)

    print(f"Proposals written to: {output_csv}")
    print(f"Total proposals: {len(proposals)}")


# ---------------------------
# Phase 2: Execute with Dedup
# ---------------------------

def execute_merges_from_csv(csv_file: str):
    with open(csv_file, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        for row in reader:
            if row.get("action") != "merge":
                continue

            source = Path(row["source_folder"])
            target = Path(row["target_folder"])

            if not source.exists():
                print(f"SKIP: Source missing -> {source}")
                continue

            if not target.exists():
                print(f"SKIP: Target missing -> {target}")
                continue

            print(f"\nMerging: {source} -> {target}")

            # Build hash map of target folder
            target_hashes = build_hash_map(target)

            for item in source.iterdir():
                if not item.is_file():
                    continue

                try:
                    src_hash = hash_file(item)
                except Exception as e:
                    print(f"  ERROR hashing {item}: {e}")
                    continue

                # Case 1: Exact duplicate (same content)
                if src_hash in target_hashes:
                    print(f"  DELETE duplicate: {item}")
                    item.unlink()
                    continue

                dest = target / item.name

                # Case 2: Same name but different content
                if dest.exists():
                    new_name = f"{item.stem}_from_merge{item.suffix}"
                    dest = target / new_name
                    print(f"  RENAME + MOVE: {item} -> {dest}")
                else:
                    print(f"  MOVE: {item} -> {dest}")

                shutil.move(str(item), str(dest))

                # Update hash map after move
                try:
                    new_hash = hash_file(dest)
                    target_hashes[new_hash] = dest
                except:
                    pass

            # Remove source folder if empty
            try:
                source.rmdir()
                print(f"  Removed folder: {source}")
            except OSError:
                print(f"  Could not remove (not empty): {source}")


# ---------------------------
# CLI
# ---------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["propose", "execute"])
    parser.add_argument("--path", help="Base folder path")
    parser.add_argument("--csv", required=True)

    args = parser.parse_args()

    if args.mode == "propose":
        if not args.path:
            raise ValueError("Provide --path for propose mode")
        propose_merges(args.path, args.csv)

    elif args.mode == "execute":
        execute_merges_from_csv(args.csv)