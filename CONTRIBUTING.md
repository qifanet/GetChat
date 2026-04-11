# Contributing Guide

欢迎向本仓库贡献代码、文档和建议。

为了保证团队协作顺畅、代码历史清晰、主分支稳定，请在提交前阅读并遵守以下规范。

---

## 1. 基本协作原则

1. **不要直接向 `main` 分支提交代码**
   - 所有改动都应从 `main` 拉出新分支进行开发
   - 所有改动都通过 Pull Request（PR）合并

2. **一个分支只做一件事**
   - 一个 PR 尽量只解决一个问题或实现一个功能
   - 不要把多个不相关改动混在一起提交

3. **提交前请先自测**
   - 确认代码可以运行
   - 确认没有明显报错
   - 如有测试，请确保测试通过

4. **不要提交敏感信息**
   - 包括但不限于：
     - API Key
     - Token
     - 密码
     - 私钥
     - 数据库连接串
     - `.env` 文件中的敏感配置

5. **遵守 Review 意见**
   - PR 提交后，请配合审查意见修改
   - 所有 review 对话应尽量处理完成后再合并

---

## 2. 开发流程

### 第一步：同步最新主分支

请先切换到 `main`，并拉取最新代码：

```bash
git switch main
git pull origin main
```

如果你的 Git 版本较旧，也可以使用：

```bash
git checkout main
git pull origin main
```

---

### 第二步：创建功能分支

请不要直接在 `main` 上开发。

建议分支命名规范如下：

- `feature/xxx`：新功能
- `fix/xxx`：问题修复
- `docs/xxx`：文档修改
- `refactor/xxx`：重构
- `test/xxx`：测试相关
- `chore/xxx`：构建、配置、维护类改动

例如：

```bash
git switch -c feature/login-page
```

或：

```bash
git checkout -b feature/login-page
```

---

### 第三步：开发并提交

修改代码后，先查看状态：

```bash
git status
```

添加改动：

```bash
git add .
```

提交代码：

```bash
git commit -m "feat: add login page"
```

---

### 第四步：推送到远程分支

第一次推送分支：

```bash
git push -u origin feature/login-page
```

之后继续更新这个分支时：

```bash
git push
```

---

### 第五步：创建 Pull Request

请在 GitHub 上从你的开发分支向 `main` 发起 Pull Request。

请确保：

- PR 标题清晰明确
- PR 描述说明：
  - 改了什么
  - 为什么改
  - 如何测试
  - 是否有风险或影响范围

---

## 3. 分支命名规范

推荐使用以下格式：

- `feature/user-login`
- `feature/add-export-api`
- `fix/login-null-error`
- `docs/update-readme`
- `refactor/auth-module`
- `test/add-auth-tests`
- `chore/update-github-templates`

请避免使用含义不清的分支名，例如：

- `test1`
- `new`
- `aaa`
- `mybranch`

---

## 4. Commit Message 规范

建议使用以下前缀：

- `feat:` 新功能
- `fix:` 修复问题
- `docs:` 文档更新
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 维护性修改

示例：

```bash
git commit -m "feat: add user registration endpoint"
git commit -m "fix: handle empty response in login"
git commit -m "docs: update setup instructions"
git commit -m "refactor: simplify auth middleware"
```

---

## 5. Pull Request 规范

### PR 标题建议

请尽量使用清晰、简洁的标题，例如：

- `feat: add login page`
- `fix: resolve token validation bug`
- `docs: improve installation guide`

### PR 内容要求

PR 描述中建议包含：

- **变更内容**
- **变更原因**
- **测试方式**
- **影响范围**
- **是否需要额外关注**

### 合并要求

通常需要满足以下条件后才能合并：

- 至少 1 位 reviewer 审核通过
- 所有 review 对话已处理
- 分支与 `main` 已同步到最新
- 自动检查通过（如仓库已启用 CI）
- 未发现明显安全问题或敏感信息

---

## 6. 代码与安全要求

提交代码前请检查：

- [ ] 没有提交密码、Token、私钥等敏感信息
- [ ] 没有提交不必要的大文件
- [ ] 没有提交构建产物、缓存目录或本地环境目录
- [ ] 已补充必要注释或文档
- [ ] 改动范围清晰，便于 review

常见不应提交的内容包括：

- `.env`
- `node_modules/`
- `venv/`
- `__pycache__/`
- `dist/`
- `build/`
- IDE 配置目录（如 `.idea/`）

请通过 `.gitignore` 排除这些文件。

---

## 7. Review 与合并建议

- 开发者提交 PR 后，请耐心等待 review
- 如收到修改建议，请在原分支继续提交修复
- 不要新开重复 PR
- 仓库建议使用 **Squash and merge** 保持主分支历史简洁

---

## 8. 维护者说明

当前默认维护者/主要审查人：

- `@NianLog`

如果你不确定某个改动是否符合规范，请先在 Issue、Discussion 或 PR 中说明背景。

---

感谢你的贡献与协作。

---

