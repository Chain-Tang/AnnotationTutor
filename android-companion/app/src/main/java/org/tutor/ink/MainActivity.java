package org.tutor.ink;
import android.app.*;import android.os.*;import android.content.*;import android.widget.*;import android.net.Uri;
import com.google.mlkit.common.model.*;import java.io.*;import java.security.SecureRandom;import org.json.*;

public final class MainActivity extends Activity {
  private TextView status;private String pending;
  @Override public void onCreate(Bundle state){super.onCreate(state);LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(24,40,24,24);ScrollView scroll=new ScrollView(this);scroll.addView(box);setContentView(scroll);status=new TextView(this);box.addView(status);
    if(getSharedPreferences("ink",0).getString("token","").isEmpty())rotate();showPairing();
    button(box,"Start paired local recognition",()->{Intent intent=new Intent(this,InkService.class);if(Build.VERSION.SDK_INT>=26)startForegroundService(intent);else startService(intent);});
    button(box,"Stop recognition",()->stopService(new Intent(this,InkService.class)));
    button(box,"Revoke pairing and create a new token",()->{rotate();showPairing();});
    for(String language:new String[]{"zh-Hans","en-US"}){
      button(box,"Download "+language+" model (network required)",()->{try{RemoteModelManager.getInstance().download(InkRecognition.model(language),new DownloadConditions.Builder().build()).addOnSuccessListener(v->status.setText("Model ready: "+language)).addOnFailureListener(e->status.setText("Model download failed; try again on a working connection."));}catch(Exception e){status.setText("Language model unavailable");}});
      button(box,"Remove "+language+" model",()->{try{RemoteModelManager.getInstance().deleteDownloadedModel(InkRecognition.model(language)).addOnSuccessListener(v->status.setText("Removed: "+language));}catch(Exception e){status.setText("Model removal failed");}});
    }
    button(box,"Recognize a request file (manual fallback)",()->{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(intent,1);});
    if(state!=null)pending=state.getString("result");if(pending!=null)button(box,"Save pending result",this::saveResult);
  }
  private void button(LinearLayout box,String title,Runnable run){Button button=new Button(this);button.setText(title);button.setOnClickListener(v->run.run());box.addView(button);}
  private void rotate(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);String token=android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP|android.util.Base64.URL_SAFE);getSharedPreferences("ink",0).edit().putString("token",token).putInt("port",38763).apply();}
  private void showPairing(){status.setText("Tutor Ink preview\nLoopback port: 38763\nPairing token (keep private):\n"+getSharedPreferences("ink",0).getString("token","")+"\n\nPaste these in Tutor's Android connection settings. Models are downloaded only by pressing a download button. Keep this app's recognition service running while using Tutor.");status.setTextIsSelectable(true);}
  private void saveResult(){if(pending==null)return;try{JSONObject result=new JSONObject(pending);Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,result.getString("id")+".result.json");startActivityForResult(intent,2);}catch(Exception e){status.setText("No valid result");}}
  @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(result!=RESULT_OK||data==null||data.getData()==null)return;Uri uri=data.getData();
    if(request==1)new Thread(()->{try(InputStream stream=getContentResolver().openInputStream(uri)){ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int n;while((n=stream.read(buffer))!=-1){bytes.write(buffer,0,n);if(bytes.size()>2_000_000)throw new IOException("request too large");}pending=InkRecognition.recognize(new JSONObject(bytes.toString("UTF-8"))).toString();runOnUiThread(this::saveResult);}catch(Exception e){runOnUiThread(()->status.setText("Recognition failed. Check that the selected file is a Tutor request and its language model is downloaded."));}},"Tutor-Ink-file").start();
    else if(request==2&&pending!=null)try(OutputStream stream=getContentResolver().openOutputStream(uri)){stream.write(pending.getBytes("UTF-8"));pending=null;status.setText("Saved. Return to Tutor and read the result file.");}catch(Exception e){status.setText("Could not save result");}
  }
  @Override protected void onSaveInstanceState(Bundle out){super.onSaveInstanceState(out);out.putString("result",pending);}
}
