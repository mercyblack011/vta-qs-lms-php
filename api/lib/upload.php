<?php

class UploadException extends Exception {}

const UPLOAD_ROOT = __DIR__ . '/../../uploads';

// Validates one $_FILES-shaped entry (real MIME via finfo, not the client-supplied
// one, plus size) and moves it into uploads/<subdir>/ with the same
// "<ms>-<rand><ext>" filename scheme the Node app used.
function save_upload_entry(array $file, string $subdir, array $allowedMimes, int $maxBytes, string $label): array {
    if ($file['error'] !== UPLOAD_ERR_OK) {
        throw new UploadException('Upload failed');
    }
    if ($file['size'] > $maxBytes) {
        throw new UploadException('File is too large');
    }

    $finfo = finfo_open(FILEINFO_MIME_TYPE);
    $mime = finfo_file($finfo, $file['tmp_name']);
    finfo_close($finfo);
    if (!in_array($mime, $allowedMimes, true)) {
        throw new UploadException("Only $label are allowed");
    }

    $dir = UPLOAD_ROOT . '/' . $subdir;
    if (!is_dir($dir)) mkdir($dir, 0755, true);

    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    $filename = sprintf('%d-%d%s', (int) (microtime(true) * 1000), random_int(0, 999999999), $ext ? ".$ext" : '');
    $dest = $dir . '/' . $filename;

    if (!move_uploaded_file($file['tmp_name'], $dest)) {
        throw new UploadException('Could not save uploaded file');
    }

    return ['path' => "/uploads/$subdir/$filename", 'name' => $file['name']];
}

// Single optional file field, e.g. upload.single('photo') in the Node app.
// Returns null if the field was omitted.
function handle_upload(string $field, string $subdir, array $allowedMimes, int $maxBytes, string $label): ?array {
    if (!isset($_FILES[$field]) || $_FILES[$field]['error'] === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    return save_upload_entry($_FILES[$field], $subdir, $allowedMimes, $maxBytes, $label);
}

// Multiple files under one field name, sent by the frontend as photos[] so PHP
// groups them into $_FILES['photos'] with array-shaped sub-keys instead of
// keeping only the last one. Mirrors upload.fields([{name:'photos', maxCount:10}]).
function handle_upload_multi(string $field, string $subdir, array $allowedMimes, int $maxBytes, string $label): array {
    if (!isset($_FILES[$field]) || !is_array($_FILES[$field]['name'])) return [];
    $results = [];
    foreach ($_FILES[$field]['name'] as $i => $name) {
        if ($_FILES[$field]['error'][$i] === UPLOAD_ERR_NO_FILE) continue;
        $entry = [
            'name' => $name,
            'type' => $_FILES[$field]['type'][$i],
            'tmp_name' => $_FILES[$field]['tmp_name'][$i],
            'error' => $_FILES[$field]['error'][$i],
            'size' => $_FILES[$field]['size'][$i],
        ];
        $results[] = save_upload_entry($entry, $subdir, $allowedMimes, $maxBytes, $label);
    }
    return $results;
}

// Mirrors fs.unlink(...) cleanup calls scattered through the Node routes - best
// effort, silently ignores a missing file.
function delete_uploaded_file(?string $relativePath): void {
    if (!$relativePath) return;
    $path = __DIR__ . '/../../' . ltrim($relativePath, '/');
    if (is_file($path)) @unlink($path);
}

// Shared allow-lists/size limits, one entry per src/middleware/upload*.js file.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
