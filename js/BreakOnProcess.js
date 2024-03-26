// @ShakReiner

"use strict";

// General functions
const execute = cmd => host.namespace.Debugger.Utility.Control.ExecuteCommand(cmd);
const log = msg => host.diagnostics.debugLog(`${msg}\n`);

// Handle NtCreateUserProcess breaks
function handleProcessCreation(processName, processCommand) {
    var PROCESS_PARAM_PARAM = 8;            // parameter index of _RTL_USER_PROCESS_PARAMETERS
    var NTCREATEUSERPROCESS_PARAM_NUM = 11  // number of parameters of nt!NtCreateUserProcess

    // Get the stack pointer to access arguments
    var rsp = host.currentThread.Registers.User.rsp;

    // Read all arguments. Add 1 since the first element on the stack is the return address
    var pUserProcessParams = host.memory.readMemoryValues(rsp, NTCREATEUSERPROCESS_PARAM_NUM + 1, 8)[PROCESS_PARAM_PARAM + 1];

    // Cast to _RTL_USER_PROCESS_PARAMETERS
    var procParams = host.createTypedObject(pUserProcessParams, "nt", "_RTL_USER_PROCESS_PARAMETERS");

    // Get the executable name from process parameters
    var imagePathName = procParams.ImagePathName.toString().slice(1, -1).split("\\");
    var fileName = imagePathName[imagePathName.length - 1];

    // Continue execution if process doesn't match name/command
    if (processName.toUpperCase() != fileName.toUpperCase()) {
        log(`[+] New process: ${fileName}`);
        return false;
    }
    if (processCommand) {
        let commandLinePresent = procParams.CommandLine.toString().toUpperCase().includes(processCommand.toUpperCase());
        if (!commandLinePresent) { return false; }
    }

    log(`[!] New process: ${fileName}`);

    // Get the address of the new process handle
    var rcx = host.currentThread.Registers.User.rcx;
    // Ditto with the main thread
    var rdx = host.currentThread.Registers.User.rdx;

    // Set a breakpoint on the usermode call, immediately after `KiSystemServiceCopyEnd`.
    var ra = host.currentThread.Stack.Frames[2].Attributes.ReturnOffset;

    // log(`[!] NtCreateUserProcess called from ${ra}`);

    execute(`bp /1 /p $proc /t $thread ${ra} "dx @$scriptContents.handleProcessCreated(${rcx}, ${rdx})"`);
    return false; // Instruct WinDbg to continue execution.
}

function handleProcessCreated(phProc, phThrd) {
    // Get the return value.
    // log(`[!] NtCreateUserProcess returned: ${host.currentThread.Registers.User.rax}`);

    // Get the _EPROCESS of the new process.
    var hproc = host.memory.readMemoryValues(phProc, 1, 8);
    var hthrd = host.memory.readMemoryValues(phThrd, 1, 8);

    // Note that we will have to truncate the upper 48 bits because
    // the high bit is set for kernel-mode handles.
    //
    // Due to Javascript bullshit, the pointer is not a number. So a reasonable
    // operation like bitwise AND will not work (instead returning 0 instead of
    // doing anything reasonable, like throwing an exception).
    // So we have to call into WinDbg to ask it to do something that JavaScript
    // is incapable of doing: basic integer arithmetic.
    hproc = host.evaluateExpression(`${hproc} & 0xFFFF`);
    hthrd = host.evaluateExpression(`${hthrd} & 0xFFFF`);

    // log(`[!] New process / thread: ${hproc} (${phProc}) / ${hthrd} (${phThrd})`);

    // https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/native-objects-in-javascript-extensions-debugger-objects
    var eprocess = host.currentProcess.Io.Handles[hproc].Object.UnderlyingObject.targetLocation.address;
    var kthread = host.currentProcess.Io.Handles[hthrd].Object.UnderlyingObject.targetLocation.address;

    log(`[!] New process / thread: ${hproc} (${eprocess}) / ${hthrd} (${kthread})`);

    // Find the start address for the thread.
    var ethread = host.createTypedObject(kthread, "nt", "_ETHREAD");
    var startAddress = ethread.StartAddress.address;

    // log(`[!] New thread start address: ${startAddress}`);
    execute(`bp /1 /p ${eprocess} /t ${ethread.address} ${startAddress}`);
    execute(`gc`); // Instruct WinDbg to continue.
}

function breakOnProcess(processName, processCommand) {
    // Set a breakpoint
    var bp = host.namespace.Debugger.Utility.Control.SetBreakpointAtOffset('NtCreateUserProcess', 0, 'nt');
    var args = `"${processName}"`;
    if (processCommand) {
        args += `, "${processCommand}"`;
    }
    bp.Condition = `@$scriptContents.handleProcessCreation(${args})`;

    log(`[+] Breaking in new '${processName}' processes`);
}

function initializeScript() {
    log(`Break on new process (for KD)\n
Usage: 
        !breakonprocess <name>[, <commandline>] 
                           or 
        dx @$scriptContents.breakOnProcess(<name>[, <commandline>])
  
    Parameters are not case sensitive 
    New processes will match if their command line contains the commandline requested`)

    return [
        new host.apiVersionSupport(1, 3),
        new host.functionAlias(breakOnProcess, "breakonprocess"),
        new host.functionAlias(breakOnProcess, "bop")
    ];
}
