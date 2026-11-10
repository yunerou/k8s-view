# Runbook: Release New Extension Version

Tài liệu này định nghĩa quy trình chuẩn dành cho **AI Agent** khi nhận được yêu cầu tạo / release version mới cho một extension trong repository này (`vscode-extension`).

---

## 📌 Nguyên tắc chung

- **Workspace Root**: `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension`
- **Quy tắc hiển thị đường dẫn**: Khi thao tác với file (đọc, sửa, xoá, tạo mới), **bắt buộc luôn ghi Full Path (đường dẫn tuyệt đối)** của file trong kết quả phản hồi để người dùng dễ theo dõi và sử dụng.
- **Quy tắc Semantic Versioning (SemVer)**: Định dạng version là `MAJOR.MINOR.PATCH`. Khi tăng **minor version**, giá trị `MINOR` tăng thêm 1 và `PATCH` được reset về `0` (ví dụ: `0.0.5` ➔ `0.1.0`, `1.2.3` ➔ `1.3.0`).

---

## 🛠️ Quy trình thực hiện (SOP)

Khi người dùng yêu cầu tạo version mới cho extension `<extension-folder>` (ví dụ: `k8s-view`, `aws-view`, `gitlab-ci-view`):

### Bước 1: Kiểm tra và tăng Minor Version trong `package.json`

1. **Đọc `package.json`**:
   - Đường dẫn file: `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/package.json`
   - Đọc field `"version"`.
2. **Cập nhật version**:
   - Tăng minor version thêm 1 theo SemVer:
     $$\text{MAJOR}.\text{MINOR}.\text{PATCH} \longrightarrow \text{MAJOR}.(\text{MINOR} + 1).0$$
   - Ví dụ:
     - `0.0.5` ➔ `0.1.0`
     - `0.1.0` ➔ `0.2.0`
     - `1.2.4` ➔ `1.3.0`
3. **Lưu thay đổi**:
   - Ghi lại nội dung đã sửa vào `package.json`.
   - Hiển thị thông báo kèm **Full Path** của file:
     - *Updated file*: `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/package.json` (`<old_version>` ➔ `<new_version>`).

---

### Bước 2: Xoá file `.vsix` phiên bản cũ

1. **Kiểm tra file `.vsix` cũ**:
   - Tìm file `.vsix` đang tồn tại trong thư mục `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/`.
2. **Xoá file**:
   - Xoá các file `.vsix` của version cũ để tránh nhầm lẫn với bản build mới.
   - Ghi nhận và hiển thị **Full Path** của file đã bị xoá:
     - *Deleted file*: `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/<name>-<old_version>.vsix`

---

### Bước 3: Build và đóng gói phiên bản mới

1. **Thực thi lệnh từ Workspace Root**:
   - Chạy lệnh theo tuần tự bắt đầu từ thư mục gốc của project:
     ```bash
     cd <extension-folder> && pnpm run build && pnpm run package
     ```
   - Chờ lệnh hoàn thành và kiểm tra exit code để đảm bảo quá trình build và package không gặp lỗi.

---

### Bước 4: Kiểm tra và báo cáo kết quả

1. **Xác nhận file `.vsix` mới tạo**:
   - Kiểm tra file `.vsix` mới sinh ra trong thư mục extension tương ứng:
     `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/<name>-<new_version>.vsix`
2. **Báo cáo kết quả cho người dùng**:
   - Cung cấp danh sách các file liên quan kèm **Full Path**:
     - **File cấu hình đã sửa**: `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/package.json`
     - **File VSIX đã build thành công**: `/Users/ngocntr/Documents/github.com/yunerou/vscode-extension/<extension-folder>/<name>-<new_version>.vsix`
     - **Version mới**: `<new_version>`

---

## 📋 Checklist kiểm tra nhanh cho AI Agent

- [ ] Đã đọc chính xác `version` hiện tại trong `package.json`?
- [ ] Đã tăng `minor` version thêm 1 và reset `patch` về 0?
- [ ] Đã xoá file `.vsix` cũ và thông báo full path?
- [ ] Đã chạy đúng lệnh `cd <extension-folder> && pnpm run build && pnpm run package` từ root?
- [ ] Build thành công không có lỗi?
- [ ] Đã hiển thị **Full Path** của file `.vsix` mới được tạo ra?

