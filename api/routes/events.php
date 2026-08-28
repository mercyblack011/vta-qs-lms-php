<?php
// Mirrors src/routes/events.js. $method and $segments are set by api/index.php.
// The Node app used multer .fields() for a combined pdf + photos[] upload; here the
// frontend sends photos as photos[] (see public/js/app.js) so PHP groups them.

function attach_event_photos(array &$events): void {
    if (!$events) return;
    $ids = array_column($events, 'id');
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $photos = query("SELECT * FROM event_photos WHERE event_id IN ($placeholders) ORDER BY id", $ids);
    foreach ($events as &$ev) {
        $ev['photos'] = array_values(array_filter($photos, fn($p) => $p['event_id'] == $ev['id']));
    }
    unset($ev);
}

if ($method === 'GET' && $segments === []) {
    require_auth();
    $events = query('
        SELECT e.*, u.name AS created_by_name FROM events e
        JOIN users u ON u.id = e.created_by
        ORDER BY e.event_at IS NULL, e.event_at DESC, e.created_at DESC
    ');
    attach_event_photos($events);
    json_response(['events' => $events]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'admin');
    $pdfFile = handle_upload('pdf', 'events', ['application/pdf'], 15 * 1024 * 1024, 'PDF files');
    $photoFiles = handle_upload_multi('photos', 'events', IMAGE_TYPES, 15 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    $body = request_body();
    $name = trim($body['name'] ?? '');

    if (!$name) {
        if ($pdfFile) delete_uploaded_file($pdfFile['path']);
        foreach ($photoFiles as $f) delete_uploaded_file($f['path']);
        error_response('name is required');
    }

    $info = run(
        'INSERT INTO events (name, location, incharge, event_at, pdf_path, pdf_name, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$name, trim($body['location'] ?? ''), trim($body['incharge'] ?? ''), $body['event_at'] ?? null,
         $pdfFile ? $pdfFile['path'] : null, $pdfFile ? $pdfFile['name'] : null, $me['id']]
    );
    $eventId = $info['lastInsertRowid'];
    foreach ($photoFiles as $f) {
        run('INSERT INTO event_photos (event_id, photo_path) VALUES (?, ?)', [$eventId, $f['path']]);
    }

    $events = query('SELECT e.*, u.name AS created_by_name FROM events e JOIN users u ON u.id = e.created_by WHERE e.id = ?', [$eventId]);
    attach_event_photos($events);
    json_response(['event' => $events[0]], 201);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $event = query('SELECT * FROM events WHERE id = ?', [$segments[0]])[0] ?? null;
    $pdfFile = handle_upload('pdf', 'events', ['application/pdf'], 15 * 1024 * 1024, 'PDF files');
    $photoFiles = handle_upload_multi('photos', 'events', IMAGE_TYPES, 15 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    if (!$event) {
        if ($pdfFile) delete_uploaded_file($pdfFile['path']);
        foreach ($photoFiles as $f) delete_uploaded_file($f['path']);
        error_response('Event not found', 404);
    }

    $body = request_body();
    $name = trim($body['name'] ?? '');
    if (!$name) {
        if ($pdfFile) delete_uploaded_file($pdfFile['path']);
        foreach ($photoFiles as $f) delete_uploaded_file($f['path']);
        error_response('name is required');
    }

    $oldPdfPath = $event['pdf_path'];
    run(
        'UPDATE events SET name = ?, location = ?, incharge = ?, event_at = ?, pdf_path = ?, pdf_name = ? WHERE id = ?',
        [$name, trim($body['location'] ?? ''), trim($body['incharge'] ?? ''), $body['event_at'] ?? null,
         $pdfFile ? $pdfFile['path'] : $event['pdf_path'], $pdfFile ? $pdfFile['name'] : $event['pdf_name'], $event['id']]
    );
    if ($pdfFile && $oldPdfPath) delete_uploaded_file($oldPdfPath);
    foreach ($photoFiles as $f) {
        run('INSERT INTO event_photos (event_id, photo_path) VALUES (?, ?)', [$event['id'], $f['path']]);
    }

    $events = query('SELECT e.*, u.name AS created_by_name FROM events e JOIN users u ON u.id = e.created_by WHERE e.id = ?', [$event['id']]);
    attach_event_photos($events);
    json_response(['event' => $events[0]]);
}

if ($method === 'DELETE' && count($segments) === 3 && ctype_digit($segments[0]) && $segments[1] === 'photos' && ctype_digit($segments[2])) {
    $me = require_auth();
    require_role($me, 'admin');
    $photo = query('SELECT * FROM event_photos WHERE id = ? AND event_id = ?', [$segments[2], $segments[0]])[0] ?? null;
    if (!$photo) error_response('Photo not found', 404);
    run('DELETE FROM event_photos WHERE id = ?', [$photo['id']]);
    delete_uploaded_file($photo['photo_path']);
    json_response(['message' => 'Photo removed']);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $event = query('SELECT * FROM events WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$event) error_response('Event not found', 404);
    $photos = query('SELECT * FROM event_photos WHERE event_id = ?', [$event['id']]);

    run('DELETE FROM events WHERE id = ?', [$event['id']]);

    if ($event['pdf_path']) delete_uploaded_file($event['pdf_path']);
    foreach ($photos as $p) delete_uploaded_file($p['photo_path']);

    json_response(['message' => 'Event removed']);
}

error_response('Not found', 404);
