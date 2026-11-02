import { configDefaults, defineConfig } from 'vitest/config';

// The repo lives on a FAT32 drive, where macOS writes `._*` AppleDouble files.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/._*'] },
});
