// pm2 keeps the editor up and brings it back after a reboot, the same way the
// other services on this box are kept alive (pm2 save + pm2-resurrect.vbs in
// the Startup folder).
//   pm2 start ecosystem.config.js && pm2 save
//
// NOTHING HERE MAY EVER SHOW A WINDOW. venv/Scripts/python.exe is a console
// (subsystem 3) program: started by the pm2 daemon it has no console to inherit,
// so Windows gives it a brand new one and Windows Terminal pops a window on the
// owner's screen. Closing that window killed the server (the Intel Fortran
// runtime inside numpy/MKL aborts on the console CLOSE event) and pm2's
// autorestart opened it again five seconds later -- the popping window.
// pythonw.exe is the GUI-subsystem (2) twin of the same interpreter: it never
// gets a console, so there is no window to pop and nothing to close.
// windowsHide keeps any console-subsystem child hidden as well.
module.exports = {
  apps: [
    {
      name: 'image-edit',
      script: 'C:/projects/image-edit/venv/Scripts/pythonw.exe',
      args: ['C:/projects/image-edit/server.py'],
      cwd: 'C:/projects/image-edit',
      interpreter: 'none',
      windowsHide: true,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      // pythonw.exe has no console, so stdout/stderr only reach these files
      // through pm2's pipes; server.py also writes logs/image-edit.log itself.
      out_file: 'C:/projects/image-edit/logs/image-edit.out.log',
      error_file: 'C:/projects/image-edit/logs/image-edit.err.log',
      env: {
        PYTHONUNBUFFERED: '1',
        IMAGE_EDIT_HOST: '127.0.0.1',
        IMAGE_EDIT_PORT: '8410',
        // The model is loaded at startup and kept for an hour of idleness: a cold
        // load reads 29 GB off the disk and cannot be done inside a request.
        IMAGE_EDIT_IDLE_UNLOAD_MIN: '60',
        IMAGE_EDIT_PRELOAD: '1',
      },
    },
  ],
};
