import os
import sys

def clean_filenames(folder_path, target_string, replacement_string=""):
    if not os.path.isdir(folder_path):
        print(f"Error: '{folder_path}' is not a valid directory.")
        return

    for filename in os.listdir(folder_path):
        old_path = os.path.join(folder_path, filename)

        # Skip directories (only process files)
        if not os.path.isfile(old_path):
            continue

        if target_string in filename:
            new_filename = filename.replace(target_string, replacement_string).strip()
            new_path = os.path.join(folder_path, new_filename)

            # Avoid overwriting existing files
            if os.path.exists(new_path):
                print(f"Skipping (target exists): {new_filename}")
                continue

            os.rename(old_path, new_path)
            print(f"Renamed: '{filename}' -> '{new_filename}'")


if __name__ == "__main__":
    if len(sys.argv) < 3 or len(sys.argv) > 4:
        print("Usage:")
        print("  Remove:  python script.py <folder_path> <string_to_remove>")
        print("  Replace: python script.py <folder_path> <string_to_replace> <replacement_string>")
        sys.exit(1)

    folder_path = sys.argv[1]
    target_string = sys.argv[2]
    replacement_string = sys.argv[3] if len(sys.argv) == 4 else ""

    clean_filenames(folder_path, target_string, replacement_string)