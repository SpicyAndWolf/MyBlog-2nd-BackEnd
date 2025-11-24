import os

# 要排除的目录
exclude_dirs = {'.git', 'node_modules','public'}

def print_tree(root, prefix=""):
    # 获取目录内容并排序
    entries = sorted(os.listdir(root))
    entries = [e for e in entries if e not in exclude_dirs]

    for i, entry in enumerate(entries):
        path = os.path.join(root, entry)
        connector = "└── " if i == len(entries) - 1 else "├── "
        print(prefix + connector + entry)

        if os.path.isdir(path):
            extension = "    " if i == len(entries) - 1 else "│   "
            print_tree(path, prefix + extension)

if __name__ == "__main__":
    current_dir = os.getcwd()
    print(os.path.basename(current_dir))
    print_tree(current_dir)
