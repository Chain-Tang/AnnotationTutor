package org.tutor.ink;
import com.google.mlkit.vision.digitalink.*;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.android.gms.tasks.Tasks;
import org.json.*;
import java.util.concurrent.TimeUnit;

final class InkRecognition {
  static DigitalInkRecognitionModel model(String language) throws Exception {
    if (!language.equals("zh-Hans") && !language.equals("en-US")) throw new Exception("unsupported-language");
    DigitalInkRecognitionModelIdentifier id=DigitalInkRecognitionModelIdentifier.fromLanguageTag(language);
    if(id==null)throw new Exception("model-unavailable");
    return DigitalInkRecognitionModel.builder(id).build();
  }
  static JSONObject recognize(JSONObject request) throws Exception {
    if(!request.getString("format").equals("tutor-ink-request-v1"))throw new Exception("invalid-format");
    String id=request.getString("id"), fingerprint=request.getString("fingerprint"),language=request.getString("language");
    if(!id.matches("[a-fA-F0-9-]{36}")||!fingerprint.matches("[a-f0-9]{64}"))throw new Exception("invalid-identity");
    DigitalInkRecognitionModel model=model(language);
    if(!Tasks.await(RemoteModelManager.getInstance().isModelDownloaded(model),10,TimeUnit.SECONDS))throw new Exception("download-model-in-companion-first");
    JSONArray strokes=request.getJSONArray("strokes"),ids=new JSONArray();if(strokes.length()==0||strokes.length()>500)throw new Exception("stroke-limit");
    Ink.Builder ink=Ink.builder();int total=0;
    for(int i=0;i<strokes.length();i++){
      JSONObject source=strokes.getJSONObject(i);String strokeId=source.getString("id");if(strokeId.length()>160)throw new Exception("id-limit");ids.put(strokeId);
      JSONArray points=source.getJSONArray("points");total+=points.length();if(total>100000||points.length()==0||points.length()>20000)throw new Exception("point-limit");
      Ink.Stroke.Builder stroke=Ink.Stroke.builder();
      for(int j=0;j<points.length();j++){JSONObject point=points.getJSONObject(j);double x=point.getDouble("x"),y=point.getDouble("y");if(Double.isNaN(x)||Double.isInfinite(x)||Double.isNaN(y)||Double.isInfinite(y)||Math.abs(x)>1e6||Math.abs(y)>1e6)throw new Exception("invalid-coordinate");stroke.addPoint(Ink.Point.create((float)x,(float)y,point.optLong("t",j*10)));}
      ink.addStroke(stroke.build());
    }
    DigitalInkRecognizer recognizer=DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(model).build());
    try{
      RecognitionContext.Builder context=RecognitionContext.builder();String preceding=request.optString("textContext","");context.setPreContext(preceding.substring(Math.max(0,preceding.length()-1000)));
      RecognitionResult result=Tasks.await(recognizer.recognize(ink.build(),context.build()),30,TimeUnit.SECONDS);
      JSONArray alternatives=new JSONArray();for(RecognitionCandidate c:result.getCandidates())if(alternatives.length()<20)alternatives.put(c.getText());
      return new JSONObject().put("format","tutor-ink-result-v1").put("id",id).put("fingerprint",fingerprint).put("language",language).put("strokeIds",ids).put("text",alternatives.optString(0,"")).put("alternatives",alternatives);
    }finally{recognizer.close();}
  }
}
