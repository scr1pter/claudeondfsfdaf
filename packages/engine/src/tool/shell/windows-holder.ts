/**
 * Engine-authored code only: command text and environment travel over stdin as JSON, never into this script.
 * Keep it small enough for PowerShell's UTF-16 -EncodedCommand on Windows (32,767 command-line characters).
 */
const source = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
public static class VectorShellHolder {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int n; public IntPtr sd; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title; public int x,y,xs,ys,xc,yc,fill,flags;
    public short show,cb2; public IntPtr reserved2,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct SX { public SI si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT {
    public long ptime,jtime; public uint flags; public UIntPtr min,max; public uint active;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public LIMIT basic; public IO io; public UIntPtr pm,jm,pp,pj; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
    public long u,k,pu,pk; public uint faults,total,active,terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a,string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref EXT i,uint n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,out ACCOUNT i,uint n,IntPtr r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr p,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr p,IntPtr h,IntPtr q,out IntPtr d,uint a,bool inherit,uint opts);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string n,uint a,uint share,ref SA sa,uint create,uint flags,IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr attr,IntPtr value,IntPtr size,IntPtr prev,IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SX si,out PI pi);
  public class Launch { public string file,commandLine,cwd; public Dictionary<string,string> env; }
  static readonly ManualResetEvent resume=new ManualResetEvent(false), stop=new ManualResetEvent(false);
  static volatile bool badControl;
  static void Check(bool ok,string operation) { if(!ok) throw new Exception(operation+" failed ("+Marshal.GetLastWin32Error()+")"); }
  static void Emit(object value) { Console.Error.WriteLine("VECTOR_SHELL/1 "+new JavaScriptSerializer().Serialize(value)); Console.Error.Flush(); }
  static string Line(Stream stream,int max) {
    using(var bytes=new MemoryStream()) {
      for(int n=0;n<=max;n++) {
        int b=stream.ReadByte(); if(b<0) return null;
        if(b==10) return new UTF8Encoding(false,true).GetString(bytes.ToArray());
        if(n==max) throw new Exception("Control line too large"); bytes.WriteByte((byte)b);
      }
    }
    throw new Exception("Control line too large");
  }
  static bool Clean(IntPtr job,PI child,bool assigned) {
    if(child.process==IntPtr.Zero) return true;
    if(!assigned) { TerminateProcess(child.process,1); return WaitForSingleObject(child.process,3000)==0; }
    TerminateJobObject(job,1);
    var clock=System.Diagnostics.Stopwatch.StartNew();
    do {
      ACCOUNT a; if(!QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero)) return false;
      if(a.active==0) return true; Thread.Sleep(10);
    } while(clock.ElapsedMilliseconds<3000);
    return false;
  }
  public static int Run() {
    IntPtr job=IntPtr.Zero, attrs=IntPtr.Zero, handles=IntPtr.Zero, jobs=IntPtr.Zero, env=IntPtr.Zero, output=IntPtr.Zero, input=IntPtr.Zero;
    PI child=new PI(); bool assigned=false, attrsReady=false, cleaned=false, attempted=false;
    try {
      var stream=Console.OpenStandardInput();
      var read=Task.Run(()=>Line(stream,262144));
      if(!read.Wait(15000) || read.Result==null) throw new Exception("Configuration timeout or EOF");
      var json=new JavaScriptSerializer(); json.MaxJsonLength=262144;
      var cfg=json.Deserialize<Launch>(read.Result);
      if(cfg==null || String.IsNullOrEmpty(cfg.file) || String.IsNullOrEmpty(cfg.commandLine) || cfg.commandLine.Length>32766 || cfg.env==null) throw new Exception("Invalid configuration");
      Check(SetHandleInformation(GetStdHandle(-10),1,0),"Control inheritance");
      Check(SetHandleInformation(GetStdHandle(-12),1,0),"Status inheritance");
      job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"Create job");
      var limits=new EXT(); limits.basic.flags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))),"Kill-on-close");
      var sa=new SA(); sa.n=Marshal.SizeOf(typeof(SA)); sa.inherit=1;
      input=CreateFileW("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),"Null input");
      Check(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out output,0,true,2),"Output handle");
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,2,0,ref size),"Process attributes"); attrsReady=true;
      handles=Marshal.AllocHGlobal(IntPtr.Size*2); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output);
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*2),IntPtr.Zero,IntPtr.Zero),"Handle whitelist");
      // Assign during creation: holder death between CreateProcess and a later assignment must leave no orphan.
      // Windows 10+ supports JOB_LIST; failure refuses the command instead of launching without containment.
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000d),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"Atomic job assignment");
      var values=new SortedDictionary<string,string>(cfg.env,StringComparer.OrdinalIgnoreCase); var block=new StringBuilder();
      foreach(var entry in values) {
        if(entry.Key.Length==0 || entry.Key.IndexOf('=')>=0 || entry.Key.IndexOf('\0')>=0 || entry.Value==null || entry.Value.IndexOf('\0')>=0) throw new Exception("Invalid environment");
        block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
      }
      block.Append('\0'); if(block.Length>65536) throw new Exception("Environment too large");
      env=Marshal.StringToHGlobalUni(block.ToString());
      var start=new SX(); start.si.cb=Marshal.SizeOf(typeof(SX)); start.si.flags=0x100;
      start.si.input=input; start.si.output=output; start.si.error=output; start.attrs=attrs;
      Check(CreateProcessW(cfg.file,new StringBuilder(cfg.commandLine),IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cfg.cwd,ref start,out child),"Create suspended job process"); assigned=true;
      var control=new Thread(()=> {
        try {
          bool acknowledged=false;
          for(int n=0;n<4;n++) {
            var line=Line(stream,128);
            if(line==null || line=="{\"type\":\"stop\"}") { stop.Set(); return; }
            if(!acknowledged && line=="{\"type\":\"resume\"}") { acknowledged=true; resume.Set(); continue; }
            badControl=true; stop.Set(); return;
          }
          badControl=true; stop.Set();
        } catch { badControl=true; stop.Set(); }
      }); control.IsBackground=true; control.Start();
      Emit(new {type="ready",pid=child.pid});
      if(WaitHandle.WaitAny(new WaitHandle[]{resume,stop},10000)!=0 || stop.WaitOne(0)) throw new Exception("PID acknowledgement refused or timed out");
      Check(ResumeThread(child.thread)!=0xffffffff,"Resume process");
      Emit(new {type="running",pid=child.pid});
      uint code=1;
      while(!stop.WaitOne(0)) {
        uint wait=WaitForSingleObject(child.process,25);
        if(wait==0) { Check(GetExitCodeProcess(child.process,out code),"Exit status"); break; }
        if(wait!=258) throw new Exception("Process wait failed");
      }
      attempted=true; cleaned=Clean(job,child,assigned);
      if(!cleaned) throw new Exception("Job termination could not be proven");
      if(badControl) throw new Exception("Invalid control message");
      Emit(new {type="exit",exitCode=code,terminationProven=true}); return 0;
    } catch(Exception error) {
      if(!attempted) { attempted=true; cleaned=Clean(job,child,assigned); }
      Emit(new {type="error",message=error.Message.Length>160?"Windows containment failed":error.Message,terminationProven=cleaned}); return 1;
    } finally {
      if(!attempted) Clean(job,child,assigned);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(child.process!=IntPtr.Zero) CloseHandle(child.process);
      if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);
      if(output!=IntPtr.Zero) CloseHandle(output);
      if(attrsReady) DeleteProcThreadAttributeList(attrs);
      if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
  }
}
`

export const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try { Add-Type -TypeDefinition @'\n${source}\n'@ -ReferencedAssemblies System.Web.Extensions } catch { [Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"error","terminationProven":true,"message":"Windows containment helper unavailable"}'); exit 1 }; exit [VectorShellHolder]::Run()`

export function argumentsForHolder() {
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  if (encoded.length > 30_000) throw new Error("Windows containment helper exceeds the command-line limit")
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-InputFormat",
    "Text",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
    encoded,
  ]
}

export * as WindowsHolder from "./windows-holder"
