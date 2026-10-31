import os
import re
import shutil
import argparse


def extract_title(filename):
    """
    Extract the title from a CBZ filename while removing
    volume/chapter indicators.

    Examples:
        One Piece v01.cbz              -> One Piece
        One Piece v02.cbz              -> One Piece
        One Piece Vol. 03.cbz          -> One Piece
        One Piece Volume 4.cbz         -> One Piece
        One Piece Chapter 45.cbz       -> One Piece
        One Piece - Ch. 12.cbz         -> One Piece
        Berserk v01 Chapter 3.cbz      -> Berserk
    """

    # Remove the .cbz extension
    name = os.path.splitext(filename)[0]

    # Normalize underscores/dots to spaces.
    # Keep hyphens because they can sometimes legitimately be
    # part of a title.
    name = name.replace("_", " ")
    name = re.sub(r"\s+", " ", name).strip()

    # ---------------------------------------------------------
    # Remove volume indicators
    # ---------------------------------------------------------

    volume_patterns = [
        # v01, v1, V01, v001
        r"\bv\d+\b",

        # vol 01, vol. 01, vol01
        r"\bvol\.?\s*\d+\b",

        # volume 01, volume. 01
        r"\bvolume\.?\s*\d+\b",

        # volume 01-03 / vol 01-03
        r"\bvol(?:ume)?\.?\s*\d+\s*[-–—]\s*\d+\b",

        # v01-v03
        r"\bv\d+\s*[-–—]\s*v?\d+\b",
    ]

    for pattern in volume_patterns:
        name = re.sub(pattern, "", name, flags=re.IGNORECASE)

    # ---------------------------------------------------------
    # Remove chapter indicators
    # ---------------------------------------------------------

    chapter_patterns = [
        # chapter 01, chapter 1, Chapter 100
        r"\bchapter\.?\s*\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?\b",

        # ch 01, ch. 01, ch01
        r"\bch\.?\s*\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?\b",

        # c01, c001
        r"\bc\d+(?:\.\d+)?\b",
    ]

    for pattern in chapter_patterns:
        name = re.sub(pattern, "", name, flags=re.IGNORECASE)

    # ---------------------------------------------------------
    # Remove common standalone number patterns left behind
    # only when they occur after a volume/chapter separator.
    #
    # This prevents accidentally removing legitimate numbers
    # from titles such as "20th Century Boys".
    # ---------------------------------------------------------

    name = re.sub(
        r"(?:^|\s)[-–—]\s*\d+(?:\.\d+)?(?:\s*[-–—]\s*\d+(?:\.\d+)?)?\s*$",
        "",
        name
    )

    # ---------------------------------------------------------
    # Clean up leftover separators and whitespace
    # ---------------------------------------------------------

    name = re.sub(r"\s*[-–—]\s*$", "", name)
    name = re.sub(r"^\s*[-–—]\s*", "", name)

    name = re.sub(r"\s+", " ", name).strip()

    # Remove trailing punctuation/separators
    name = re.sub(r"[\s._-]+$", "", name).strip()

    return name


def organize_cbz_files(filepath, dry_run=False):
    """
    Find all CBZ files in filepath, determine their titles,
    create a folder for each unique title, and move the CBZ
    files into their corresponding folders.
    """

    filepath = os.path.abspath(filepath)

    if not os.path.isdir(filepath):
        print(f"Error: Directory does not exist:")
        print(filepath)
        return

    # Find CBZ files in the specified directory.
    files = [
        f for f in os.listdir(filepath)
        if os.path.isfile(os.path.join(filepath, f))
        and f.lower().endswith(".cbz")
    ]

    if not files:
        print("No .cbz files found.")
        return

    # Dictionary:
    # {
    #     "One Piece": ["One Piece v01.cbz", "One Piece v02.cbz"],
    #     "Berserk": ["Berserk v01.cbz"]
    # }
    titles = {}

    for filename in files:
        title = extract_title(filename)

        if not title:
            print(f"WARNING: Could not determine title for: {filename}")
            continue

        titles.setdefault(title, []).append(filename)

    # ---------------------------------------------------------
    # Display detected titles
    # ---------------------------------------------------------

    print("\nDetected titles:")
    print("-" * 70)

    for title, cbz_files in sorted(titles.items()):
        print(f"\n{title}")
        for filename in cbz_files:
            print(f"    {filename}")

    print("\n" + "-" * 70)
    print(f"CBZ files found: {len(files)}")
    print(f"Unique titles:   {len(titles)}")

    if dry_run:
        print("\nDRY RUN: No files were moved.")
        return

    # ---------------------------------------------------------
    # Create folders and move files
    # ---------------------------------------------------------

    moved_count = 0
    error_count = 0

    for title, cbz_files in titles.items():

        title_folder = os.path.join(filepath, title)

        # Create the title folder if it doesn't exist
        os.makedirs(title_folder, exist_ok=True)

        for filename in cbz_files:

            source = os.path.join(filepath, filename)
            destination = os.path.join(title_folder, filename)

            try:
                # If the file is already in the destination,
                # don't move it again.
                if os.path.abspath(source) == os.path.abspath(destination):
                    continue

                shutil.move(source, destination)
                moved_count += 1

            except Exception as e:
                print(f"ERROR moving '{filename}': {e}")
                error_count += 1

    # ---------------------------------------------------------
    # Summary
    # ---------------------------------------------------------

    print("\nOrganization complete.")
    print("-" * 70)
    print(f"Unique titles: {len(titles)}")
    print(f"Files moved:   {moved_count}")
    print(f"Errors:        {error_count}")


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Organize CBZ files into folders based on their titles, "
            "ignoring volume and chapter numbers."
        )
    )

    parser.add_argument(
        "filepath",
        help="Path containing the CBZ files"
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show detected titles without moving any files"
    )

    args = parser.parse_args()

    organize_cbz_files(
        args.filepath,
        dry_run=args.dry_run
    )


if __name__ == "__main__":
    main()