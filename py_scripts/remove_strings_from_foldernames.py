import os
import re
import argparse


def rename_folders(folder_path, search_pattern, replacement="", use_regex=False):
    if not os.path.isdir(folder_path):
        print(f"Error: '{folder_path}' is not a valid directory.")
        return

    successful_changes = 0
    duplicate_skips = 0
    unchanged = 0

    for folder_name in os.listdir(folder_path):
        old_path = os.path.join(folder_path, folder_name)

        # Only process folders
        if not os.path.isdir(old_path):
            continue

        if use_regex:
            new_folder_name = re.sub(search_pattern, replacement, folder_name)
        else:
            new_folder_name = folder_name.replace(search_pattern, replacement)

        new_folder_name = new_folder_name.strip()

        # No change
        if new_folder_name == folder_name:
            unchanged += 1
            continue

        # Prevent empty folder names
        if not new_folder_name:
            print(
                f"Skipping '{folder_name}' "
                f"(resulting folder name would be empty)"
            )
            duplicate_skips += 1
            continue

        new_path = os.path.join(folder_path, new_folder_name)

        # Skip if destination already exists
        if os.path.exists(new_path):
            print(
                f"Skipping '{folder_name}' -> '{new_folder_name}' "
                f"(duplicate folder name exists)"
            )
            duplicate_skips += 1
            continue

        try:
            os.rename(old_path, new_path)
            successful_changes += 1
            print(f"Renamed: '{folder_name}' -> '{new_folder_name}'")
        except Exception as e:
            print(f"Error renaming '{folder_name}': {e}")

    print("\n" + "=" * 50)
    print("Summary")
    print("=" * 50)
    print(f"Successful folder renames : {successful_changes}")
    print(f"Duplicate renames skipped : {duplicate_skips}")
    print(f"Unchanged folders         : {unchanged}")
    print("=" * 50)


def main():
    parser = argparse.ArgumentParser(
        description="Rename folders by removing or replacing text."
    )

    parser.add_argument(
        "folder_path",
        help="Path containing the folders to rename"
    )

    parser.add_argument(
        "search_pattern",
        help="String or regex pattern to search for"
    )

    parser.add_argument(
        "replacement",
        nargs="?",
        default="",
        help="Replacement string (defaults to removal)"
    )

    parser.add_argument(
        "--regex",
        action="store_true",
        help="Treat search_pattern as a regular expression"
    )

    args = parser.parse_args()

    rename_folders(
        args.folder_path,
        args.search_pattern,
        args.replacement,
        args.regex
    )


if __name__ == "__main__":
    main()