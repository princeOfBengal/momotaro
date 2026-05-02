import os
import re
import csv
import shutil
from pathlib import Path

# ---------------------------
# Helpers
# ---------------------------

def normalize_name(name: str) -> str:
    """
    Remove content inside () and [] and normalize spacing/lowercase.
    """
    name = re.sub(r"\(.*?\)", "", name)
    name = re.sub(r"\[.*?\]", "", name)
    name = re.sub(r"\s+", " ", name)
    return name.strip().lower()


def get_folder_groups(base_path: Path):
    """
    Group folders by normalized name.
    """
    groups = {}

    for item in base_path.iterdir():
        if item.is_dir():
            norm = normalize_name(item.name)
            groups.setdefault(norm, []).append(item)

    return groups


# ---------------------------
# Phase 1: Generate Proposals
# ---------------------------

def propose_merges(base_path: str, output_csv: str):
    base = Path(base_path)
    groups = get_folder_groups(base)

    proposals = []

    for norm_name, folders in groups.items():
        if len(folders) < 2:
            continue

        # Sort by length of original name (shortest = target)
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

    # Write CSV
    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=proposals[0].keys() if proposals else [
            "action", "source_folder", "target_folder",
            "normalized_name", "source_name", "target_name"
        ])
        writer.writeheader()
        writer.writerows(proposals)

    print(f"Proposals written to: {output_csv}")
    print(f"Total proposals: {len(proposals)}")


# ---------------------------
# Phase 2: Execute Merges
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

            print(f"Merging: {source} -> {target}")

            for item in source.iterdir():
                dest = target / item.name

                # Avoid overwriting
                if dest.exists():
                    print(f"  SKIP file exists: {dest}")
                    continue

                shutil.move(str(item), str(dest))

            # Remove source folder if empty
            try:
                source.rmdir()
                print(f"  Removed folder: {source}")
            except OSError:
                print(f"  Could not remove (not empty): {source}")


# ---------------------------
# Example Usage
# ---------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["propose", "execute"])
    parser.add_argument("--path", help="Base folder path")
    parser.add_argument("--csv", required=True, help="CSV file path")

    args = parser.parse_args()

    if args.mode == "propose":
        if not args.path:
            raise ValueError("You must provide --path for propose mode")
        propose_merges(args.path, args.csv)

    elif args.mode == "execute":
        execute_merges_from_csv(args.csv)