import re

path = r'c:\Users\huang\Desktop\super-clip\src-tauri\src\main.rs'

with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

lines = content.split('\n')
new_lines = []
for line in lines:
    if '.on_window_event' in line and 'setup' in line:
        new_lines.append('        .on_window_event(|event| match event.event() {')
        new_lines.append('            tauri::WindowEvent::CloseRequested { api, .. } => {')
        new_lines.append('                // Prevent the window from actually closing - hide to tray instead')
        new_lines.append('                event.window().hide().unwrap();')
        new_lines.append('                api.prevent_close();')
        new_lines.append('            }')
        new_lines.append('            _ => {}')
        new_lines.append('        })')
        new_lines.append('        .setup(|app| {')
    else:
        new_lines.append(line)

with open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(new_lines))

print('Fixed!')
