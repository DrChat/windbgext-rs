use std::ffi::{CStr, CString};

use anyhow::Context;
use clap::Parser;

use windows::{
    core::{ComInterface, HRESULT},
    Win32::{
        Foundation::{E_FAIL, S_OK},
        System::Diagnostics::Debug::Extensions::{
            IDebugClient4, IDebugControl7, DEBUG_ANY_ID, DEBUG_BREAKPOINT_CODE,
            DEBUG_OUTCTL_ALL_CLIENTS,
        },
    },
};

trait DebugControlExt {
    fn PrintLn(&self, mask: u32, message: std::fmt::Arguments) -> windows::core::Result<()>;
}

#[allow(non_snake_case)]
impl DebugControlExt for IDebugControl7 {
    fn PrintLn(&self, mask: u32, message: std::fmt::Arguments) -> windows::core::Result<()> {
        let msg = CString::new(format_args!("{}\n", message).to_string()).unwrap();

        unsafe { self.Output(mask, windows::core::PCSTR(msg.as_ptr() as *const u8)) }
    }
}

mod util {
    use super::*;

    fn parse<T: Parser>(args: *const std::ffi::c_char) -> Result<T, clap::Error> {
        let args = unsafe { CStr::from_ptr(args) }.to_string_lossy();
        T::try_parse_from(shell_words::split(&args).unwrap().into_iter())
    }

    fn handle_result(client: IDebugClient4, res: anyhow::Result<()>) -> HRESULT {
        match res {
            Ok(_) => S_OK,
            Err(e) => {
                if let Ok(ctrl) = client.cast::<IDebugControl7>() {
                    let _ = ctrl.PrintLn(DEBUG_OUTCTL_ALL_CLIENTS, format_args!("error: {:?}", e));
                }

                println!("error: {:?}", e);

                if let Ok(e) = e.downcast::<windows::core::Error>() {
                    e.code()
                } else {
                    E_FAIL
                }
            }
        }
    }

    pub fn wrap_call<A: Parser>(
        func: impl FnOnce(IDebugClient4, A) -> anyhow::Result<()>,
        client: IDebugClient4,
        args: *const std::ffi::c_char,
    ) -> HRESULT {
        let args = match parse::<A>(args) {
            Ok(a) => a,
            Err(e) => {
                let msg = e.render();
                if let Ok(ctrl) = client.cast::<IDebugControl7>() {
                    let _ = ctrl.PrintLn(
                        DEBUG_OUTCTL_ALL_CLIENTS,
                        format_args!("{}", msg),
                    );
                }

                println!("error: {:?}", e);
                return E_FAIL;
            }
        };

        handle_result(client.clone(), func(client, args))
    }
}

use util::wrap_call;

/// Called by WinDbg when our plugin is loaded.
#[export_name = "DebugExtensionInitialize"]
extern "C" fn init(version: *mut u32, flags: *mut u32) -> HRESULT {
    unsafe {
        // We're running version 1.0 of this plugin.
        *version = 0x0001_0000;
        // Must be set to zero.
        *flags = 0;
    }

    S_OK
}

/// `!bpproc`: Set a breakpoint when a process starts.
#[export_name = "bpproc"]
extern "C" fn bpproc(client: IDebugClient4, args: *const std::ffi::c_char) -> HRESULT {
    #[derive(Parser)]
    #[clap(no_binary_name = true)]
    struct Args {
        /// The process to find.
        process: String,
    }

    let f = |client: IDebugClient4, args: Args| -> anyhow::Result<()> {
        let ctrl: IDebugControl7 = client.cast()?;
        ctrl.PrintLn(
            DEBUG_OUTCTL_ALL_CLIENTS,
            format_args!("process: {}", args.process),
        )?;

        Ok(())
    };

    wrap_call(f, client, args)
}
