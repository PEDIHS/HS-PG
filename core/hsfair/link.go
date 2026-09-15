package hsfair
import (
 "context"
 "github.com/xtls/xray-core/common"
 "github.com/xtls/xray-core/common/buf"
 "github.com/xtls/xray-core/common/session"
 "github.com/xtls/xray-core/transport"
)
type reader struct{buf.Reader;ctx context.Context;key string;cancel context.CancelFunc}
func(r *reader)ReadMultiBuffer()(buf.MultiBuffer,error){b,e:=r.Reader.ReadMultiBuffer();if err:=Default.Wait(r.ctx,r.key,int(b.Len()));err!=nil{buf.ReleaseMulti(b);return nil,err};return b,e}
func(r *reader)Interrupt(){r.cancel();common.Interrupt(r.Reader)}
func(r *reader)Close()error{return common.Close(r.Reader)}
type writer struct{buf.Writer;ctx context.Context;key string;cancel context.CancelFunc}
func(w *writer)WriteMultiBuffer(b buf.MultiBuffer)error{if err:=Default.Wait(w.ctx,w.key,int(b.Len()));err!=nil{buf.ReleaseMulti(b);return err};return w.Writer.WriteMultiBuffer(b)}
func(w *writer)Interrupt(){w.cancel();common.Interrupt(w.Writer)}
func(w *writer)Close()error{return common.Close(w.Writer)}
func Wrap(ctx context.Context,link *transport.Link){
 in:=session.InboundFromContext(ctx);if in==nil||in.User==nil||in.User.Email==""{return}
 // Splicing would bypass link pacing, including on sessions opened before the threshold.
 in.CanSpliceCopy=3
 key:=Key(in.User.Email,in.Tag)
 ctx,cancel:=context.WithCancel(ctx)
 link.Reader=&reader{Reader:link.Reader,ctx:ctx,key:key,cancel:cancel};link.Writer=&writer{Writer:link.Writer,ctx:ctx,key:key,cancel:cancel}
}
