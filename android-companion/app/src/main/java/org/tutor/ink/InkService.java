package org.tutor.ink;
import android.app.*;import android.content.*;import android.os.*;
import java.io.*;import java.net.*;import java.nio.charset.StandardCharsets;import java.security.MessageDigest;import java.util.*;import java.util.concurrent.*;import org.json.*;

public final class InkService extends Service {
  private ServerSocket server;private final ExecutorService worker=Executors.newSingleThreadExecutor();private final Semaphore busy=new Semaphore(1);
  @Override public void onCreate(){super.onCreate();
    if(Build.VERSION.SDK_INT>=26)((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel("ink","Local handwriting recognition",NotificationManager.IMPORTANCE_LOW));
    Notification.Builder builder=Build.VERSION.SDK_INT>=26?new Notification.Builder(this,"ink"):new Notification.Builder(this);
    startForeground(1,builder.setSmallIcon(android.R.drawable.ic_menu_edit).setContentTitle("Tutor Ink — local recognition").setContentText("Only paired requests on this device are accepted.").setOngoing(true).build());
    new Thread(()->{try{int port=getSharedPreferences("ink",0).getInt("port",38763);server=new ServerSocket();server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),port));while(!server.isClosed()){Socket socket=server.accept();if(!busy.tryAcquire()){socket.close();continue;}worker.execute(()->{try{serve(socket);}finally{busy.release();}});}}catch(Exception e){stopSelf();}},"Tutor-Ink-listener").start();
  }
  private static String line(InputStream stream)throws Exception{ByteArrayOutputStream bytes=new ByteArrayOutputStream();int b;while((b=stream.read())!=-1&&b!=10){if(bytes.size()>8192)throw new IOException("header-limit");if(b!=13)bytes.write(b);}return bytes.toString("US-ASCII");}
  private void serve(Socket socket){try(Socket close=socket){socket.setSoTimeout(45000);InputStream input=new BufferedInputStream(socket.getInputStream());String[] first=line(input).split(" ");if(first.length!=3)throw new IOException("bad-request");Map<String,String> headers=new HashMap<>();for(int i=0;i<40;i++){String row=line(input);if(row.isEmpty())break;int split=row.indexOf(':');if(split>0)headers.put(row.substring(0,split).toLowerCase(Locale.ROOT),row.substring(split+1).trim());}
    String secret=getSharedPreferences("ink",0).getString("token","");String auth=headers.getOrDefault("authorization","");
    if(secret.length()<32||!MessageDigest.isEqual(auth.getBytes(StandardCharsets.UTF_8),("Bearer "+secret).getBytes(StandardCharsets.UTF_8))||headers.containsKey("origin")){reply(socket,401,new JSONObject().put("error","pairing-required"));return;}
    String host=headers.getOrDefault("host","");if(!host.equals("127.0.0.1:"+server.getLocalPort())){reply(socket,403,new JSONObject().put("error","invalid-host"));return;}
    if(first[0].equals("GET")&&first[1].equals("/status")){reply(socket,200,new JSONObject().put("service","tutor-ink").put("protocol",1));return;}
    if(!first[0].equals("POST")||!first[1].equals("/recognize")){reply(socket,404,new JSONObject().put("error","not-found"));return;}
    int length=Integer.parseInt(headers.getOrDefault("content-length","0"));if(length<1||length>2_000_000||headers.containsKey("transfer-encoding"))throw new IOException("body-limit");byte[] bytes=new byte[length];int read=0;while(read<length){int n=input.read(bytes,read,length-read);if(n<0)throw new EOFException();read+=n;}
    try{reply(socket,200,InkRecognition.recognize(new JSONObject(new String(bytes,StandardCharsets.UTF_8))));}catch(Exception e){reply(socket,422,new JSONObject().put("error","recognition-unavailable-check-model-and-request"));}
  }catch(Exception ignored){/* Never log stroke data, pairing tokens or recognized text. */}}
  private static void reply(Socket socket,int code,JSONObject value)throws Exception{byte[] body=value.toString().getBytes(StandardCharsets.UTF_8);OutputStream out=socket.getOutputStream();out.write(("HTTP/1.1 "+code+" Result\r\nContent-Type: application/json\r\nContent-Length: "+body.length+"\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(body);out.flush();}
  @Override public int onStartCommand(Intent intent,int flags,int id){return START_NOT_STICKY;}
  @Override public IBinder onBind(Intent intent){return null;}
  @Override public void onDestroy(){try{if(server!=null)server.close();}catch(IOException ignored){}worker.shutdownNow();super.onDestroy();}
  @Override public void onTimeout(int startId,int fgsType){stopSelf();}
}
