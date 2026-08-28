<?php
// Mirrors src/routes/timetable.js. $method and $segments are set by api/index.php.

const TT_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const TT_SLOT_COUNT = 4; // 8.30-10.30, 10.45-12.15, 12.45-2.45, 2.45-4.15

function empty_schedule(): array {
    $schedule = [];
    foreach (TT_DAYS as $d) $schedule[$d] = array_fill(0, TT_SLOT_COUNT, '');
    return $schedule;
}

function clean_schedule($input): array {
    $schedule = empty_schedule();
    if (is_array($input)) {
        foreach (TT_DAYS as $d) {
            if (isset($input[$d]) && is_array($input[$d])) {
                for ($i = 0; $i < TT_SLOT_COUNT; $i++) {
                    $schedule[$d][$i] = trim((string) ($input[$d][$i] ?? ''));
                }
            }
        }
    }
    return $schedule;
}

// Viewing is open to everyone logged in; only admin can edit.
if ($method === 'GET' && $segments === []) {
    require_auth();
    $courseId = $_GET['course_id'] ?? null;
    if (!$courseId) error_response('course_id is required');
    $row = query('SELECT * FROM timetables WHERE course_id = ?', [$courseId])[0] ?? null;
    $schedule = $row ? json_decode($row['schedule'], true) : empty_schedule();
    json_response(['schedule' => $schedule, 'updated_at' => $row ? $row['updated_at'] : null]);
}

if ($method === 'PUT' && $segments === []) {
    $me = require_auth();
    require_role($me, 'admin');
    $body = request_body();
    $courseId = $body['course_id'] ?? null;
    if (!$courseId) error_response('course_id is required');
    if (!query('SELECT id FROM courses WHERE id = ?', [$courseId])) error_response('Course not found', 404);

    $cleaned = clean_schedule($body['schedule'] ?? null);
    run('
        INSERT INTO timetables (course_id, schedule, updated_by) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE schedule = VALUES(schedule), updated_by = VALUES(updated_by), updated_at = NOW()
    ', [$courseId, json_encode($cleaned), $me['id']]);

    json_response(['schedule' => $cleaned]);
}

error_response('Not found', 404);
