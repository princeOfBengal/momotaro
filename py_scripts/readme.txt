In this folder, py_scripts, contains useful python scripts that can be utilized to organize your manga library. These scripts are not used by the app. You may use them to organize your manga directory, before initiating a scan from the app to reflect the updates/changes.



Scripts:

1. clean_manga_directories.py

Suggests folders of manga with similar names that can be combined. This way, you may copy in new sources of manga that you have downloaded, then run this script to combine folders in the event that you already have the manga in a similarly named folder. Implements a two-phase approach to cleanup.

	1. Scan + propose merges → export CSV (no changes made)
	2. User edits CSV → script executes exactly what remains

	Key Design Choices:
	- Normalization rule (your requirement):
	- Remove anything in () or []
	- Normalize whitespace + case
	- Only merge when the cleaned names match exactly
	- Prefer the shorter original folder name as the target
	- Never overwrite files — skip conflicts safely
	- CSV acts as the single source of truth for execution


	Step 1 — Generate proposals

	code:
		python script.py propose --path "D:\Manga" --csv proposals.csv

	You’ll get something like:

	action	source_folder	target_folder	normalized_name
	merge	Dead Mount Death Play (Digital) (UP!) (Oak)	Dead Mount Death Play (Digital) (Oak)	dead mount death pla

	Step 2 — Manually edit proposals.csv

	- Delete rows you don’t agree with
	- Optionally adjust target/source if needed

	Step 3 — Execute cleanup

	code:
		python script.py execute --csv proposals.csv


2. remove_strings_from_filenames.py


Given a folder path and a string as an argument, goes into the folder path and removes the string from all the filenames in the folder.

	code:

		python remove_strings_from_filenames.py /path/to/folder "String To Remove"


The script can also replace the string with another string if given a second argument:


	code:

		python script.py /path/to/folder "String To Replace" "String to Replace With"



